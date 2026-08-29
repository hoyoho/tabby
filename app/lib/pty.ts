import * as nodePTY from 'node-pty'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain } from 'electron'
import { Application } from './app'
import { UTF8Splitter } from './utfSplitter'
import { Subject, debounceTime } from 'rxjs'

class PTYDataQueue {
    private buffers: Buffer[] = []
    private delta = 0
    private maxChunk = 1024 * 100
    private maxDelta = this.maxChunk * 5
    private flowPaused = false
    private decoder = new UTF8Splitter()
    private output$ = new Subject<Buffer>()
    private sub: import('rxjs').Subscription|null = null
    private stopped = false

    constructor (private pty: nodePTY.IPty, private onData: (data: Buffer) => void) {
        this.sub = this.output$.pipe(debounceTime(500)).subscribe(() => {
            const remainder = this.decoder.flush()
            if (remainder.length) {
                this.onData(remainder)
            }
        })
    }

    push (data: Buffer) {
        if (this.stopped) {
            return
        }
        this.buffers.push(data)
        this.maybeEmit()
    }

    ack (length: number) {
        if (this.stopped) {
            return
        }
        this.delta -= length
        this.maybeEmit()
    }

    /**
     * Tears the queue down before the PTY is killed: no more pump reads (pauses
     * are dropped), no more produces/flushes against a closing ConPTY, and no
     * late debounce delivery after teardown.
     */
    stop () {
        this.stopped = true
        this.buffers = []
        this.sub?.unsubscribe()
        this.sub = null
    }

    private maybeEmit () {
        if (this.delta <= this.maxDelta && this.flowPaused) {
            this.resume()
            return
        }
        if (this.buffers.length > 0) {
            if (this.delta > this.maxDelta && !this.flowPaused) {
                this.pause()
                return
            }

            const buffersToSend = []
            let totalLength = 0
            while (totalLength < this.maxChunk && this.buffers.length) {
                totalLength += this.buffers[0].length
                buffersToSend.push(this.buffers.shift())
            }

            if (buffersToSend.length === 0) {
                return
            }

            let toSend = Buffer.concat(buffersToSend)
            if (toSend.length > this.maxChunk) {
                this.buffers.unshift(toSend.slice(this.maxChunk))
                toSend = toSend.slice(0, this.maxChunk)
            }
            this.emitData(toSend)
            this.delta += toSend.length

            if (this.buffers.length) {
                setImmediate(() => this.maybeEmit())
            }
        }
    }

    private emitData (data: Buffer) {
        const validChunk = this.decoder.write(data)
        this.onData(validChunk)
        this.output$.next(validChunk)
    }

    private pause () {
        this.pty.pause()
        this.flowPaused = true
    }

    private resume () {
        this.pty.resume()
        this.flowPaused = false
        this.maybeEmit()
    }
}

export class PTY {
    private pty: nodePTY.IPty
    private outputQueue: PTYDataQueue
    exited = false
    private killing = false

    constructor (private id: string, private app: Application, ...args: any[]) {
        this.pty = (nodePTY as any).spawn(...args)
        for (const key of ['close', 'exit']) {
            (this.pty as any).on(key, (...eventArgs) => this.emit(key, ...eventArgs))
        }

        this.outputQueue = new PTYDataQueue(this.pty, data => {
            setImmediate(() => this.emit('data', data))
        })

        this.pty.onData(data => this.outputQueue.push(Buffer.from(data)))
        this.pty.onExit(() => {
            this.exited = true
        })
    }

    getPID (): number {
        return this.pty.pid
    }

    resize (columns: number, rows: number): void {
        if (this.exited || this.killing) {
            return
        }
        if (!(this.pty as any)._writable) {
            return
        }
        try {
            this.pty.resize(columns, rows)
        } catch {
            // The pty may have exited between the flag check and the call
        }
    }

    write (buffer: Buffer): void {
        if (this.exited || this.killing) {
            return
        }
        if (!(this.pty as any)._writable) {
            return
        }
        try {
            this.pty.write(buffer as any)
        } catch {
            // pty may have just exited
        }
    }

    ackData (length: number): void {
        this.outputQueue.ack(length)
    }

    /**
     * Tears the PTY down in a way that minimises the native ConPTY close/monitor
     * race: stop the output pump first, mark the PTY as killing so no late
     * write/resize can touch the half-closed native handle, then ask node-pty
     * to kill. If the child already exited (or another kill beat us here), this
     * is a no-op.
     */
    kill (signal?: string): void {
        if (this.exited || this.killing) {
            return
        }
        this.killing = true
        this.outputQueue.stop()
        try {
            this.pty.kill(signal)
        } catch {
            // The ConPTY may already be closing on its exit worker — nothing to
            // do on our side, the native layer owns the handle now.
        }
    }

    private emit (event: string, ...args: any[]) {
        this.app.broadcast(`pty:${this.id}:${event}`, ...args)
        if (event === 'exit' || event === 'close') {
            setImmediate(() => this.cleanup?.())
        }
    }

    private cleanup: (() => void)|null = null

    /** Lets the owning manager drop its registry entry once the pty is done. */
    bindCleanup (fn: () => void): void {
        this.cleanup = fn
    }
}

export class PTYManager {
    private ptys: Record<string, PTY|undefined> = {}
    private killChain = Promise.resolve()

    init (app: Application): void {
        ipcMain.on('pty:spawn', (event, ...options) => {
            const id = uuidv4().toString()
            event.returnValue = id
            const pty = new PTY(id, app, ...options)
            pty.bindCleanup(() => this.removePty(id))
            this.ptys[id] = pty
        })

        ipcMain.on('pty:exists', (event, id) => {
            event.returnValue = this.ptys[id] && !this.ptys[id].exited
        })

        ipcMain.on('pty:get-pid', (event, id) => {
            event.returnValue = this.ptys[id]?.getPID()
        })

        ipcMain.on('pty:resize', (_event, id, columns, rows) => {
            this.ptys[id]?.resize(columns, rows)
        })

        ipcMain.on('pty:write', (_event, id, data) => {
            this.ptys[id]?.write(Buffer.from(data))
        })

        ipcMain.on('pty:kill', (_event, id, signal) => {
            // Serialize native ConPTY teardown so a burst of workspace-closes
            // (each session sends pty:kill) never overlap inside node-pty.
            this.killChain = this.killChain.then(() => {
                this.ptys[id]?.kill(signal)
            })
        })

        ipcMain.on('pty:ack-data', (_event, id, length) => {
            this.ptys[id]?.ackData(length)
        })
    }

    private removePty (id: string): void {
        if (this.ptys[id]) {
            delete this.ptys[id]
        }
    }
}
