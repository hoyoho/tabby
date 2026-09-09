import * as net from 'net'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain } from 'electron'
import { Application } from './app'
import { HostedConnection, registerHostedConnectionEndpoints, dropWindowClaims, destroyAllConnections } from './hostedConnection'

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
class TelnetConnection extends HostedConnection {
    private socket: net.Socket
    queue = new TelnetDataQueue(data => this.broadcast('data', data))

    constructor (id: string, app: Application, host: string, port: number) {
        super(id, app)
        this.socket = net.connect(port, host)
        this.socket.on('connect', () => this.broadcast('open'))
        this.socket.on('data', data => this.queue.push(data))
        this.socket.on('error', err => this.broadcast('error', err.message))
        this.socket.on('close', () => {
            this.closed = true
            this.broadcast('close')
            this.notifyClosed()
        })
    }

    protected readonly protocol = 'telnet'

    protected doWrite (data: Buffer): void {
        this.socket.write(data)
    }

    protected doDestroy (): void {
        this.queue.stop()
        try {
            this.socket.destroy()
        } catch { /* ignore */ }
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

        registerHostedConnectionEndpoints('telnet', this.connections)

        ipcMain.on('telnet:ack', (_event, id, length) => {
            this.connections[id]?.queue.ack(length)
        })
    }

    /** Drops one window's claims; abandoned connections die after the grace period. */
    windowClosed (webContentsId: number): void {
        dropWindowClaims(this.connections, webContentsId)
    }

    destroyAll (): void {
        destroyAllConnections(this.connections)
    }
}
