import { ipcMain, utilityProcess, UtilityProcess } from 'electron'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { Application } from './app'
import { HostedConnection, registerHostedConnectionEndpoints, dropWindowClaims, destroyAllConnections } from './hostedConnection'
import { PTYHostCommand, PTYHostEvent } from './ptyProtocol'

/** Watchdog cadence: probe the host, and how long to wait for its answer. */
const PING_INTERVAL_MS = 2000
const PONG_TIMEOUT_MS = 5000

/**
 * One PTY host utility process. node-pty lives here, so a native ConPTY
 * teardown crash or a hung native call cannot take down the app — the main
 * process only loses the sessions this host owned and can start a fresh one.
 *
 * The host is deliberately NOT tied to a window: it is owned by the main
 * process and addressed by PTY id, which keeps cross-window transfers working
 * (the PTY never moves; only the attached window changes).
 */
class PTYHost {
    activeCount = 0

    private process: UtilityProcess
    private ready = false
    private killed = false
    private pending: PTYHostCommand[] = []
    private pingTimer: ReturnType<typeof setInterval>|null = null
    private pongTimer: ReturnType<typeof setTimeout>|null = null

    constructor (private manager: PTYManager) {
        this.process = utilityProcess.fork(path.join(__dirname, 'ptyHost.js'), [], { serviceName: 'tabby-pty-host' })
        this.process.on('spawn', () => {
            this.ready = true
            const pending = this.pending
            this.pending = []
            for (const command of pending) {
                this.process.postMessage(command)
            }
            this.armPing()
        })
        this.process.on('message', (message: PTYHostEvent) => {
            if (message.t === 'pong') {
                this.armPongTimeout()
                return
            }
            this.manager.onHostMessage(this, message)
        })
        this.process.on('exit', () => {
            this.disposeTimers()
            this.manager.onHostExit(this)
        })
    }

    send (command: PTYHostCommand): void {
        if (this.killed) {
            return
        }
        if (this.ready) {
            this.process.postMessage(command)
        } else {
            this.pending.push(command)
        }
    }

    acquire (): void {
        this.activeCount++
    }

    release (): void {
        this.activeCount--
    }

    /** Kill the process; the `exit` handler does the pool/connection cleanup. */
    terminate (): void {
        if (this.killed) {
            return
        }
        this.killed = true
        this.disposeTimers()
        try {
            this.process.kill()
        } catch { /* already gone */ }
    }

    private armPing (): void {
        this.pingTimer = setInterval(() => {
            this.send({ t: 'ping' })
            this.armPongTimeout()
        }, PING_INTERVAL_MS)
        this.armPongTimeout()
    }

    private armPongTimeout (): void {
        if (this.pongTimer) {
            clearTimeout(this.pongTimer)
        }
        this.pongTimer = setTimeout(() => {
            // The host stopped answering: it is hung. Killing it turns "all local
            // terminals stall forever" into "they close and the host restarts".
            this.manager.onHostHung(this)
        }, PONG_TIMEOUT_MS)
    }

    private disposeTimers (): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer)
            this.pingTimer = null
        }
        if (this.pongTimer) {
            clearTimeout(this.pongTimer)
            this.pongTimer = null
        }
    }
}

/**
 * Main-process bookkeeping for one local PTY, mirroring the other hosted
 * connections (SSH/serial/telnet): window attachers, the abandonment grace
 * timer and teardown. The node-pty handle itself lives in the owning
 * [[PTYHost]].
 */
class PTYConnection extends HostedConnection {
    protected readonly protocol = 'pty'

    private pid = 0
    private pidWaiters: ((pid: number) => void)[] = []
    private cleaned = false

    constructor (id: string, app: Application, public host: PTYHost) {
        super(id, app)
    }

    /** Resolves once the host has reported the pid (0 if it never will). */
    waitForPID (): Promise<number> {
        if (this.pid) {
            return Promise.resolve(this.pid)
        }
        return new Promise(resolve => this.pidWaiters.push(resolve))
    }

    setPID (pid: number): void {
        this.settlePID(pid)
    }

    resize (columns: number, rows: number): void {
        this.host.send({ t: 'resize', id: this.id, cols: columns, rows })
    }

    ackData (length: number): void {
        this.host.send({ t: 'ack', id: this.id, length })
    }

    protected doWrite (data: Buffer): void {
        this.host.send({ t: 'write', id: this.id, data })
    }

    protected doDestroy (): void {
        this.host.send({ t: 'kill', id: this.id })
    }

    /** A node-pty event from the host; exit/close finalise the connection. */
    onHostEvent (event: string, args: any[]): void {
        this.broadcast(event, ...args)
        if ((event === 'exit' || event === 'close') && !this.cleaned) {
            this.cleaned = true
            this.cancelGrace()
            this.notifyClosed()
        }
    }

    /** The owning host crashed or hung: this PTY is gone for good. */
    onHostGone (): void {
        this.closed = true
        this.cancelGrace()
        this.settlePID(0)
        this.broadcast('exit', { exitCode: -1 })
        this.broadcast('close')
        if (!this.cleaned) {
            this.cleaned = true
            this.notifyClosed()
        }
    }

    private settlePID (pid: number): void {
        this.pid = pid
        const waiters = this.pidWaiters
        this.pidWaiters = []
        for (const resolve of waiters) {
            resolve(pid)
        }
    }
}

/**
 * Owns the PTY host process pool and proxies renderer IPC to it. The main
 * process never touches node-pty directly, so a native crash while tearing a
 * session down only kills the owning host — the app survives and the affected
 * tabs are closed via the usual `exit`/`close` events.
 *
 * `terminal.ptyHostMode` selects the pool shape: `'shared'` keeps one host for
 * every local session (lowest memory), `'per-session'` gives each its own
 * (a crash/hang is contained to that session). Defaults to per-session on
 * Windows, where the native teardown is the fragile one.
 */
export class PTYManager {
    private connections: Record<string, PTYConnection|undefined> = {}
    private hosts = new Set<PTYHost>()
    private sharedHost: PTYHost|null = null
    private app!: Application

    init (app: Application): void {
        this.app = app

        ipcMain.on('pty:spawn', (event, ...options) => {
            const id = uuidv4().toString()
            event.returnValue = id
            const host = this.assignHost()
            const conn = new PTYConnection(id, app, host)
            conn.bindCleanup(() => {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete this.connections[id]
                host.release()
                this.maybeReap(host)
            })
            conn.attachers.add(event.sender.id)
            this.connections[id] = conn
            host.acquire()
            host.send({ t: 'spawn', id, args: options })
        })

        // pty:attach / pty:detach / pty:kill / pty:write — the shared hosted-
        // connection endpoints, exactly like SSH/serial/telnet.
        registerHostedConnectionEndpoints('pty', this.connections)

        ipcMain.handle('pty:get-pid', (_event, id) => this.connections[id]?.waitForPID() ?? 0)

        ipcMain.on('pty:resize', (_event, id, columns, rows) => {
            this.connections[id]?.resize(columns, rows)
        })

        ipcMain.on('pty:ack-data', (_event, id, length) => {
            this.connections[id]?.ackData(length)
        })
    }

    /** Drops one window's claims; abandoned connections die after the grace period. */
    windowClosed (webContentsId: number): void {
        dropWindowClaims(this.connections, webContentsId)
    }

    destroyAll (): void {
        destroyAllConnections(this.connections)
        for (const host of this.hosts) {
            host.terminate()
        }
        this.hosts.clear()
        this.sharedHost = null
    }

    /** @hidden host callback: route one event to its connection. */
    onHostMessage (_host: PTYHost, message: PTYHostEvent): void {
        if (message.t === 'pong') {
            return
        }
        const conn = this.connections[message.id]
        switch (message.t) {
            case 'spawned':
                conn?.setPID(message.pid)
                break
            case 'error':
                conn?.onHostGone()
                break
            case 'event':
                conn?.onHostEvent(message.event, message.args)
                break
        }
    }

    /** @hidden host callback: every PTY it owned is gone. */
    onHostExit (host: PTYHost): void {
        if (!this.hosts.delete(host)) {
            return
        }
        if (this.sharedHost === host) {
            this.sharedHost = null
        }
        for (const conn of Object.values(this.connections)) {
            if (conn && conn.host === host) {
                conn.onHostGone()
            }
        }
    }

    /** @hidden host callback: hung (watchdog timeout) — kill and let exit clean up. */
    onHostHung (host: PTYHost): void {
        host.terminate()
    }

    private assignHost (): PTYHost {
        if (this.mode === 'per-session') {
            const host = new PTYHost(this)
            this.hosts.add(host)
            return host
        }
        if (!this.sharedHost) {
            this.sharedHost = new PTYHost(this)
            this.hosts.add(this.sharedHost)
        }
        return this.sharedHost
    }

    private maybeReap (host: PTYHost): void {
        // Per-session hosts are never reused: drop them as soon as they idle.
        if (this.mode === 'per-session' && host.activeCount === 0) {
            host.terminate()
        }
    }

    private get mode (): 'shared'|'per-session' {
        const configured = this.app.configStore?.terminal?.ptyHostMode
        if (configured === 'shared' || configured === 'per-session') {
            return configured
        }
        return process.platform === 'win32' ? 'per-session' : 'shared'
    }
}
