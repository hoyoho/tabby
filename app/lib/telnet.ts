import * as net from 'net'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain } from 'electron'
import { Application } from './app'

/**
 * How long a connection with zero attached renderers survives. Covers the
 * cross-window drag race: the source window detaches (keepPTYAlive) before
 * the target window attaches, and a dropped/failed transfer must not leak
 * an open socket forever.
 */
const GRACE_PERIOD_MS = 10000

/** Chunk size and in-flight IPC window for renderer backpressure. */
const DATA_CHUNK = 1024 * 100
const DATA_WINDOW = DATA_CHUNK * 5

/**
 * Renderer-side flow control for the `telnet:<id>:data` stream. Data is
 * buffered here and released in chunks only while the unacked in-flight
 * window stays under `DATA_WINDOW`; beyond that, chunks hold back until the
 * renderer acks. The TCP socket itself is never paused — once the queue is
 * full, the kernel socket buffer fills and the TCP window closes, which is
 * the final damping stage (mirrors `PTYDataQueue` in `pty.ts`).
 */
class TelnetDataQueue {
    private buffers: Buffer[] = []
    private delta = 0
    private stopped = false

    constructor (private onData: (data: Buffer) => void) { }

    push (data: Buffer): void {
        if (this.stopped) {
            return
        }
        this.buffers.push(data)
        this.maybeEmit()
    }

    ack (length: number): void {
        if (this.stopped) {
            return
        }
        this.delta -= length
        this.maybeEmit()
    }

    stop (): void {
        this.stopped = true
        this.buffers = []
    }

    private maybeEmit (): void {
        if (this.delta > DATA_WINDOW) {
            return
        }
        while (this.buffers.length && this.delta <= DATA_WINDOW) {
            let toSend = this.buffers.shift()!
            if (toSend.length > DATA_CHUNK) {
                this.buffers.unshift(toSend.slice(DATA_CHUNK))
                toSend = toSend.slice(0, DATA_CHUNK)
            }
            this.delta += toSend.length
            this.onData(toSend)
        }
    }
}

/**
 * Main-process host for one live telnet TCP connection. The renderer only
 * ever sees this through IPC events (`telnet:<id>:*`), mirroring how local
 * PTYs are hosted in `pty.ts`.
 */
class TelnetConnection {
    private socket: net.Socket
    queue = new TelnetDataQueue(data => this.emit('data', data))
    closed = false
    private graceTimer: NodeJS.Timeout|null = null
    attachers = new Set<number>()

    constructor (private id: string, private app: Application, host: string, port: number) {
        this.socket = net.connect(port, host)
        this.socket.on('connect', () => this.emit('open'))
        this.socket.on('data', data => this.queue.push(data))
        this.socket.on('error', err => this.emit('error', err.message))
        this.socket.on('close', () => {
            this.closed = true
            this.emit('close')
            setImmediate(() => this.cleanup?.())
        })
    }

    write (data: Buffer): void {
        if (this.closed) {
            return
        }
        try {
            this.socket.write(data)
        } catch { /* socket may have just died */ }
    }

    cancelGrace (): void {
        if (this.graceTimer) {
            clearTimeout(this.graceTimer)
            this.graceTimer = null
        }
    }

    /** Starts the abandoned-connection countdown (no-op if attachers remain). */
    armGrace (): void {
        if (this.graceTimer || this.closed || this.attachers.size) {
            return
        }
        this.graceTimer = setTimeout(() => {
            this.graceTimer = null
            if (!this.attachers.size && !this.closed) {
                this.destroy()
            }
        }, GRACE_PERIOD_MS)
        this.graceTimer.unref?.()
    }

    destroy (): void {
        if (this.closed) {
            return
        }
        this.closed = true
        this.cancelGrace()
        this.queue.stop()
        try {
            this.socket.destroy()
        } catch { /* ignore */ }
    }

    private emit (event: string, ...args: any[]): void {
        this.app.broadcast(`telnet:${this.id}:${event}`, ...args)
    }

    private cleanup: (() => void)|null = null

    /** Lets the owning manager drop its registry entry once the socket is done. */
    bindCleanup (fn: () => void): void {
        this.cleanup = fn
    }
}

export class TelnetManager {
    private connections: Record<string, TelnetConnection|undefined> = {}

    init (app: Application): void {
        ipcMain.on('telnet:spawn', (event, host, port) => {
            const id = uuidv4().toString()
            event.returnValue = id
            const conn = new TelnetConnection(id, app, host, port)
            conn.bindCleanup(() => delete this.connections[id])
            conn.attachers.add(event.sender.id)
            this.connections[id] = conn
        })

        ipcMain.on('telnet:attach', (event, id) => {
            const conn = this.connections[id]
            if (conn && !conn.closed) {
                conn.attachers.add(event.sender.id)
                conn.cancelGrace()
                event.returnValue = true
            } else {
                event.returnValue = false
            }
        })

        ipcMain.on('telnet:detach', (event, id) => {
            const conn = this.connections[id]
            if (!conn) {
                return
            }
            conn.attachers.delete(event.sender.id)
            conn.armGrace()
        })

        ipcMain.on('telnet:kill', (_event, id) => {
            this.connections[id]?.destroy()
        })

        ipcMain.on('telnet:write', (_event, id, data) => {
            this.connections[id]?.write(Buffer.from(data))
        })

        ipcMain.on('telnet:ack', (_event, id, length) => {
            this.connections[id]?.queue.ack(length)
        })
    }

    /** Drops one window's claims; abandoned connections die after the grace period. */
    windowClosed (webContentsId: number): void {
        for (const conn of Object.values(this.connections)) {
            if (!conn) {
                continue
            }
            if (conn.attachers.delete(webContentsId)) {
                conn.armGrace()
            }
        }
    }

    destroyAll (): void {
        for (const conn of Object.values(this.connections)) {
            conn?.destroy()
        }
    }
}
