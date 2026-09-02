import { SerialPortStream } from '@serialport/stream'
import { autoDetect } from '@serialport/bindings-cpp'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain } from 'electron'
import { Application } from './app'

/**
 * How long a connection with zero attached renderers survives. Covers the
 * cross-window drag race: the source window detaches (keepPTYAlive) before
 * the target window attaches, and a dropped/failed transfer must not leak
 * an open COM port forever.
 */
const GRACE_PERIOD_MS = 10000

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
class SerialConnection {
    private port: SerialPortStream
    private opened = false
    closed = false
    private graceTimer: NodeJS.Timeout|null = null
    private cleanup: (() => void)|null = null
    attachers = new Set<number>()

    constructor (private id: string, private app: Application, options: SerialSpawnOptions) {
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
            this.emit('open')
        })
        this.port.on('data', data => this.emit('data', data))
        this.port.on('end', () => this.emit('end'))
        this.port.on('error', error => this.emit('error', error.message))
        this.port.on('close', () => {
            this.closed = true
            this.emit('close')
            setImmediate(() => this.cleanup?.())
        })
        this.port.open(error => {
            // The 'error' event already broadcast the failure — just make sure
            // the registry entry does not leak.
            if (error) {
                this.destroy()
            }
        })
    }

    write (data: Buffer): void {
        if (this.closed) {
            return
        }
        try {
            this.port.write(data)
        } catch { /* port may have just died */ }
    }

    update (options: { baudRate: number }): void {
        if (this.closed) {
            return
        }
        try {
            void this.port.update(options)
        } catch { /* ignore */ }
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

    private emit (event: string, ...args: any[]): void {
        this.app.broadcast(`serial:${this.id}:${event}`, ...args)
    }

    /** Lets the owning manager drop its registry entry once the port is done. */
    bindCleanup (fn: () => void): void {
        this.cleanup = fn
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

        ipcMain.on('serial:attach', (event, id) => {
            const conn = this.connections[id]
            if (conn && !conn.closed) {
                conn.attachers.add(event.sender.id)
                conn.cancelGrace()
                event.returnValue = true
            } else {
                event.returnValue = false
            }
        })

        ipcMain.on('serial:detach', (event, id) => {
            const conn = this.connections[id]
            if (!conn) {
                return
            }
            conn.attachers.delete(event.sender.id)
            conn.armGrace()
        })

        ipcMain.on('serial:kill', (_event, id) => {
            this.connections[id]?.destroy()
        })

        ipcMain.on('serial:write', (_event, id, data) => {
            this.connections[id]?.write(Buffer.from(data))
        })

        ipcMain.on('serial:update', (_event, id, options: { baudRate: number }) => {
            this.connections[id]?.update(options)
        })

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
