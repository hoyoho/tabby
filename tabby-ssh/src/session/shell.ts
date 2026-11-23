import { IpcRendererEvent, ipcRenderer } from 'electron'
import { Observable, Subject } from 'rxjs'
import stripAnsi from 'strip-ansi'
import { Injector } from '@angular/core'
import { LogService } from 'tabby-core'
import { BaseSession, UTF8SplitterMiddleware, InputProcessor } from 'tabby-terminal'
import { SSHSession } from './ssh'
import { SSHProfile } from '../api'

interface DrainWaiter {
    resolve: () => void
    reject: (error: Error) => void
}

/**
 * Renderer-side stand-in for one shell channel of a main-process SSH
 * connection. Data flows over `ssh:<connId>:ch:<chId>:*` events with the
 * same chunk+ack flow control as local PTYs.
 */
export class SSHShellChannelProxy {
    readonly data$ = new Subject<Buffer>()
    readonly eof$ = new Subject<void>()
    readonly closed$ = new Subject<void>()

    private wired = false
    /** Set once the channel can no longer take writes. */
    private unwired = false
    private nextDrainToken = 1
    /** Pending `drainOutput()` requests, keyed by their token. */
    private drainWaiters = new Map<number, DrainWaiter>()

    constructor (
        private connId: string,
        public id: string,
    ) { }

    wire (): void {
        if (this.wired) {
            return
        }
        this.wired = true
        ipcRenderer.on(`ssh:${this.connId}:ch:${this.id}:data`, this.dataListener)
        ipcRenderer.on(`ssh:${this.connId}:ch:${this.id}:eof`, this.eofListener)
        ipcRenderer.on(`ssh:${this.connId}:ch:${this.id}:closed`, this.closedListener)
        ipcRenderer.on(`ssh:${this.connId}:ch:${this.id}:drained`, this.drainedListener)
    }

    unwire (): void {
        if (!this.wired) {
            return
        }
        this.wired = false
        this.unwired = true
        ipcRenderer.off(`ssh:${this.connId}:ch:${this.id}:data`, this.dataListener)
        ipcRenderer.off(`ssh:${this.connId}:ch:${this.id}:eof`, this.eofListener)
        ipcRenderer.off(`ssh:${this.connId}:ch:${this.id}:closed`, this.closedListener)
        ipcRenderer.off(`ssh:${this.connId}:ch:${this.id}:drained`, this.drainedListener)
        this.data$.complete()
        this.eof$.complete()
        this.closed$.complete()
        this.failDrainWaiters()
    }

    write (data: Buffer): void {
        ipcRenderer.send('ssh:ch-write', this.connId, this.id, data)
    }

    /**
     * Resolves once the main process has handed every write issued before the
     * call to the SSH channel. The request rides the same ordered IPC stream as
     * the writes, so it cannot overtake them.
     */
    drainOutput (): Promise<void> {
        if (this.unwired) {
            return Promise.reject(new Error('Channel closed'))
        }
        const token = this.nextDrainToken++
        return new Promise((resolve, reject) => {
            this.drainWaiters.set(token, { resolve, reject })
            ipcRenderer.send('ssh:ch-drain', this.connId, this.id, token)
        })
    }

    resizePTY (dimensions: { columns: number, rows: number }): void {
        ipcRenderer.send('ssh:ch-resize', this.connId, this.id, dimensions.columns, dimensions.rows)
    }

    ackData (length: number): void {
        ipcRenderer.send('ssh:ch-ack', this.connId, this.id, length)
    }

    private dataListener = (_e: IpcRendererEvent, data: Buffer) => this.data$.next(Buffer.from(data))
    private eofListener = () => this.eof$.next()
    private closedListener = () => {
        this.unwired = true
        this.failDrainWaiters()
        this.closed$.next()
    }

    private drainedListener = (_e: IpcRendererEvent, token: number) => {
        const waiter = this.drainWaiters.get(token)
        if (!waiter) {
            return
        }
        this.drainWaiters.delete(token)
        waiter.resolve()
    }

    private failDrainWaiters (): void {
        const waiters = [...this.drainWaiters.values()]
        this.drainWaiters.clear()
        for (const waiter of waiters) {
            waiter.reject(new Error('Channel closed'))
        }
    }
}

export class SSHShellSession extends BaseSession {
    shell?: SSHShellChannelProxy
    get serviceMessage$ (): Observable<string> { return this.serviceMessage }
    private serviceMessage = new Subject<string>()
    private ssh: SSHSession|null
    private destroying = false

    /**
     * When set, destroy() tears down this session's listeners/state but keeps
     * the underlying main-process connection and shell channel alive for the
     * target window of a cross-window drag.
     */
    keepPTYAlive = false

    constructor (
        injector: Injector,
        ssh: SSHSession,
        private profile: SSHProfile,
    ) {
        super(injector.get(LogService).create(`ssh-shell-${profile.options.host}-${profile.options.port}`))
        this.ssh = ssh
        this.setLoginScriptsOptions(this.profile.options)
        this.ssh.serviceMessage$.subscribe(m => this.serviceMessage.next(m))
        this.middleware.push(new UTF8SplitterMiddleware())
        this.middleware.push(new InputProcessor(profile.options.input))
    }

    async start (options?: { restoreFromChannelId?: string|null }): Promise<void> {
        if (!this.ssh) {
            throw new Error('SSH session not set')
        }
        const ssh = this.ssh
        const connId = ssh.getID()
        if (!connId) {
            throw new Error('SSH connection is gone')
        }

        ssh.ref()
        ssh.willDestroy$.subscribe(() => {
            this.destroy()
        })

        let chId: string|null = null
        if (options?.restoreFromChannelId) {
            const ok: boolean = await ipcRenderer.invoke('ssh:ch-attach', connId, options.restoreFromChannelId)
            if (ok) {
                chId = options.restoreFromChannelId
            }
        }

        if (!chId) {
            this.logger.debug('Opening shell')
            try {
                chId = await ssh.openShellChannel({ x11: this.profile.options.x11 })
            } catch (err) {
                if (err.toString().includes('Unable to request X11')) {
                    this.emitServiceMessage('    Make sure `xauth` is installed on the remote side')
                }
                throw new Error(`Remote rejected opening a shell channel: ${err}`)
            }
        }

        const shell = this.shell = new SSHShellChannelProxy(connId, chId)
        shell.wire()

        this.open = true
        this.logger.debug('Shell open')

        if (!options?.restoreFromChannelId) {
            this.loginScriptProcessor?.executeUnconditionalScripts()
        }

        shell.data$.subscribe(data => {
            shell.ackData(data.length)
            this.emitOutput(data)
        })

        shell.eof$.subscribe(() => {
            this.logger.info('Shell session ended')
            if (this.open) {
                this.destroy()
            }
        })

        // Some servers shut the connection down without a clean EOF; the tab
        // must still close instead of staying as a seemingly-live session.
        shell.closed$.subscribe(() => {
            this.logger.info('Shell channel closed')
            if (this.open) {
                this.destroy()
            }
        })
    }

    emitServiceMessage (msg: string): void {
        this.serviceMessage.next(msg)
        this.logger.info(stripAnsi(msg))
    }

    getID (): string|null {
        return this.shell?.id ?? null
    }

    resize (columns: number, rows: number): void {
        this.shell?.resizePTY({
            columns,
            rows,
        })
    }

    write (data: Buffer): void {
        this.shell?.write(data)
    }

    override drainOutput (): Promise<void> {
        return this.shell?.drainOutput() ?? Promise.resolve()
    }

    kill (_signal?: string): void {
        // SSH shell channels are torn down with the session, not by a signal.
    }

    override async destroy (): Promise<void> {
        if (this.destroying) {
            return
        }
        this.destroying = true
        this.logger.debug('Closing shell')
        this.serviceMessage.complete()
        if (this.keepPTYAlive) {
            // The tab is transferring to another window: release renderer
            // state only, the main-process connection/channels stay alive.
            this.releaseRendererState()
            this.shell?.unwire()
            this.shell = undefined
            this.ssh?.releaseForTransfer()
            this.ssh = null
            return
        }
        this.kill()
        this.ssh?.unref()
        this.ssh = null
        await super.destroy()
        this.shell?.unwire()
        this.shell = undefined
    }

    async getChildProcesses (): Promise<any[]> {
        return []
    }

    async gracefullyKillProcess (): Promise<void> {
        this.kill('TERM')
    }

    supportsWorkingDirectory (): boolean {
        // Same source of truth as getWorkingDirectory(): reporting a path is
        // only useful if that path can actually be handed to the remote. A
        // `~` or a local Windows path is reported but unusable, so answering
        // `true` here made callers promise a path they then could not get.
        return this.getUsableCWD() !== null
    }

    async getWorkingDirectory (): Promise<string|null> {
        return this.getUsableCWD()
    }

    /**
     * The reported directory, if it can be used outside the shell.
     *
     * Paths here are handed to the remote SFTP server verbatim. `~` is a
     * shell shorthand the protocol never expands, and OSC 1337 can inject the
     * *local* Windows home into an SSH session; both would make the built-in
     * SFTP panel open on a path that cannot exist (NoSuchFile). Returning null
     * keeps the caller's previous/default path instead.
     */
    private getUsableCWD (): string|null {
        const cwd = this.reportedCWD ?? this.titleCWD ?? null
        if (!cwd || cwd.startsWith('~') || /^[A-Za-z]:[\\/]/.test(cwd)) {
            return null
        }
        return cwd
    }
}
