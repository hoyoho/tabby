import { SerialPortStream } from '@serialport/stream'
import { autoDetect } from '@serialport/bindings-cpp'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain } from 'electron'
import { Application } from './app'
import { HostedConnection, registerHostedConnectionEndpoints, dropWindowClaims, destroyAllConnections } from './hostedConnection'

export interface SerialSpawnOptions {
    port: string
    baudrate: number|null
    databits: 5|6|7|8
    stopbits: 1|1.5|2
    parity: string
    rtscts: boolean
    xon: boolean
    xoff: boolean
    xany: boolean
}

/**
 * Main-process host for one live serial port. The renderer only ever sees
 * this through IPC events (`serial:<id>:*`), mirroring how local PTYs are
 * hosted in `pty.ts`. Holding the handle in the main process also means the
 * exclusively-opened COM port survives cross-window transfers without being
 * re-opened.
 */
class SerialConnection extends HostedConnection {
    private port: SerialPortStream
    private opened = false

    constructor (id: string, app: Application, options: SerialSpawnOptions) {
        super(id, app)
        this.port = new SerialPortStream({
            binding: autoDetect(),
            path: options.port,
            autoOpen: false,
            baudRate: parseInt(options.baudrate as any) || 9600,
            dataBits: options.databits,
            stopBits: options.stopbits,
            parity: options.parity as 'none'|'even'|'odd'|'mark'|'space',
            rtscts: options.rtscts,
            xon: options.xon,
            xoff: options.xoff,
            xany: options.xany,
        })
        this.port.on('open', () => {
            this.opened = true
            this.broadcast('open')
        })
        this.port.on('data', data => this.broadcast('data', data))
        this.port.on('end', () => this.broadcast('end'))
        this.port.on('error', error => this.broadcast('error', error.message))
        this.port.on('close', () => {
            this.closed = true
            this.broadcast('close')
            this.notifyClosed()
        })
        this.port.open(error => {
            // The 'error' event already broadcast the failure — just make sure
            // the registry entry does not leak.
            if (error) {
                this.destroy()
            }
        })
    }

    protected readonly protocol = 'serial'

    protected doWrite (data: Buffer): void {
        this.port.write(data)
    }

    protected doDestroy (): void {
        try {
            if (this.opened) {
                this.port.close(err => {
                    if (err) {
                        this.port.destroy()
                    }
                })
            } else {
                this.port.destroy()
            }
        } catch { /* ignore */ }
    }
}

export class SerialManager {
    private connections: Record<string, SerialConnection|undefined> = {}

    init (app: Application): void {
        ipcMain.on('serial:spawn', (event, options: SerialSpawnOptions) => {
            const id = uuidv4().toString()
            event.returnValue = id
            const conn = new SerialConnection(id, app, options)
            conn.bindCleanup(() => delete this.connections[id])
            conn.attachers.add(event.sender.id)
            this.connections[id] = conn
        })

        registerHostedConnectionEndpoints('serial', this.connections)

        ipcMain.handle('serial:list-ports', async () => {
            const ports = await autoDetect().list()
            return ports.map(x => ({
                name: x.path,
                description: `${x.manufacturer ?? ''} ${x.serialNumber ?? ''}`.trim() || undefined,
            }))
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
