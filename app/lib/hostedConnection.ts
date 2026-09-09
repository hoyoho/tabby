import { ipcMain } from 'electron'
import { Application } from './app'

/**
 * How long a connection with zero attached renderers survives. Covers the
 * cross-window drag race: the source window detaches (keepPTYAlive) before
 * the target window attaches, and a dropped/failed transfer must not leak
 * the underlying OS resource forever.
 */
export const GRACE_PERIOD_MS = 10000

/**
 * Common base for main-process-hosted connections (serial port, telnet
 * socket, …). The renderer only sees the connection through IPC events
 * (`<protocol>:<id>:*`); several windows can attach at once, and a connection
 * whose last renderer went away (or never attached) is destroyed after the
 * grace period.
 */
export abstract class HostedConnection {
    closed = false
    readonly attachers = new Set<number>()
    private graceTimer: ReturnType<typeof setTimeout>|null = null
    private cleanup: (() => void)|null = null

    constructor (protected readonly id: string, protected readonly app: Application) { }

    cancelGrace (): void {
        if (this.graceTimer) {
            clearTimeout(this.graceTimer)
            this.graceTimer = null
        }
    }

    /** Starts the abandoned-connection countdown (no-op if attachers remain). */
    armGrace (): void {
        if (this.graceTimer !== null || this.closed || this.attachers.size) {
            return
        }
        this.graceTimer = setTimeout(() => {
            this.graceTimer = null
            if (!this.attachers.size && !this.closed) {
                this.destroy()
            }
        }, GRACE_PERIOD_MS)
        this.graceTimer.unref()
    }

    destroy (): void {
        if (this.closed) {
            return
        }
        this.closed = true
        this.cancelGrace()
        this.doDestroy()
    }

    write (data: Buffer): void {
        if (this.closed) {
            return
        }
        try {
            this.doWrite(data)
        } catch { /* connection may have just died */ }
    }

    /** Lets the owning manager drop its registry entry once the connection is done. */
    bindCleanup (fn: () => void): void {
        this.cleanup = fn
    }

    /** IPC namespace of this connection kind, e.g. `'serial'`. */
    protected abstract readonly protocol: string

    protected abstract doWrite (data: Buffer): void

    /** Tears the underlying OS resource down; `closed` is already set. */
    protected abstract doDestroy (): void

    protected broadcast (event: string, ...args: any[]): void {
        this.app.broadcast(`${this.protocol}:${this.id}:${event}`, ...args)
    }

    /** Delays the registry cleanup until after the last broadcast. */
    protected notifyClosed (): void {
        setImmediate(() => this.cleanup?.())
    }
}

/**
 * Registers the attach/detach/kill/write endpoints shared by every
 * hosted-connection protocol (spawn and protocol-specific endpoints stay
 * with each manager).
 */
export function registerHostedConnectionEndpoints (
    protocol: string,
    connections: Record<string, HostedConnection|undefined>,
): void {
    ipcMain.on(`${protocol}:attach`, (event, id) => {
        const conn = connections[id]
        if (conn && !conn.closed) {
            conn.attachers.add(event.sender.id)
            conn.cancelGrace()
            event.returnValue = true
        } else {
            event.returnValue = false
        }
    })

    ipcMain.on(`${protocol}:detach`, (event, id) => {
        const conn = connections[id]
        if (!conn) {
            return
        }
        conn.attachers.delete(event.sender.id)
        conn.armGrace()
    })

    ipcMain.on(`${protocol}:kill`, (_event, id) => {
        connections[id]?.destroy()
    })

    ipcMain.on(`${protocol}:write`, (_event, id, data) => {
        connections[id]?.write(Buffer.from(data))
    })
}

/** Drops one window's claims; abandoned connections die after the grace period. */
export function dropWindowClaims (
    connections: Record<string, HostedConnection|undefined>,
    webContentsId: number,
): void {
    for (const conn of Object.values(connections)) {
        if (!conn) {
            continue
        }
        if (conn.attachers.delete(webContentsId)) {
            conn.armGrace()
        }
    }
}

export function destroyAllConnections (connections: Record<string, HostedConnection|undefined>): void {
    for (const conn of Object.values(connections)) {
        conn?.destroy()
    }
}
