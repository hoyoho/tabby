import * as net from 'net'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain } from 'electron'
import { Application } from './app'
import { HostedConnection, registerHostedConnectionEndpoints, dropWindowClaims, destroyAllConnections } from './hostedConnection'
import { DataQueue } from './dataQueue'

/**
 * Main-process host for one live telnet TCP connection. The renderer only
 * ever sees this through IPC events (`telnet:<id>:*`), mirroring how local
 * PTYs are hosted in `pty.ts`.
 */
class TelnetConnection extends HostedConnection {
    private socket: net.Socket
    // The TCP socket is never paused directly: once the queue is full the
    // kernel buffer fills and the TCP window closes, which damps the producer.
    queue = new DataQueue(data => this.broadcast('data', data))

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
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
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
