import * as nodePTY from 'node-pty'
import { Subject, debounceTime } from 'rxjs'
import { UTF8Splitter } from '../../tabby-core/src/utfSplitter'
import { PTYHostCommand, PTYHostEvent } from './ptyProtocol'
import { DataQueue } from './dataQueue'

/**
 * Runs node-pty inside an Electron `utilityProcess` so a native ConPTY
 * teardown crash cannot take the whole app down. The main process talks to it
 * over `process.parentPort`; see `ptyProtocol.ts` for the message shapes and
 * `pty.ts` for the main-side proxy.
 */

const port = process.parentPort

function send (message: PTYHostEvent): void {
    port.postMessage(message)
}

class PTYDataQueue {
    private decoder = new UTF8Splitter()
    private output$ = new Subject<Buffer>()
    private sub: import('rxjs').Subscription|null = null
    private queue: DataQueue

    constructor (private pty: nodePTY.IPty, private onData: (data: Buffer) => void) {
        this.queue = new DataQueue(data => {
            const validChunk = this.decoder.write(data)
            this.onData(validChunk)
            this.output$.next(validChunk)
        }, {
            pause: () => this.pty.pause(),
            resume: () => this.pty.resume(),
        })
        this.sub = this.output$.pipe(debounceTime(500)).subscribe(() => {
            const remainder = this.decoder.flush()
            if (remainder.length) {
                this.onData(remainder)
            }
        })
    }

    push (data: Buffer) {
        this.queue.push(data)
    }

    ack (length: number) {
        this.queue.ack(length)
    }

    /**
     * Tears the queue down before the PTY is killed: no more pump reads (pauses
     * are dropped), no more produces/flushes against a closing ConPTY, and no
     * late debounce delivery after teardown.
     */
    stop () {
        this.queue.stop()
        this.sub?.unsubscribe()
        this.sub = null
    }
}

/** One node-pty instance, hosted in this utility process. */
class HostedPTY {
    private pty: nodePTY.IPty
    private outputQueue: PTYDataQueue
    exited = false
    private killing = false

    constructor (private id: string, ...args: any[]) {
        this.pty = (nodePTY as any).spawn(...args)
        for (const key of ['close', 'exit']) {
            (this.pty as any).on(key, (...eventArgs: any[]) => this.emitEvent(key, ...eventArgs))
        }

        this.outputQueue = new PTYDataQueue(this.pty, data => {
            setImmediate(() => this.emitEvent('data', data))
        })

        this.pty.onData(data => this.outputQueue.push(Buffer.from(data)))
        this.pty.onExit(() => {
            this.exited = true
        })

        send({ t: 'spawned', id: this.id, pid: this.pty.pid })
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

    write (data: Uint8Array): void {
        if (this.exited || this.killing) {
            return
        }
        if (!(this.pty as any)._writable) {
            return
        }
        try {
            this.pty.write(Buffer.from(data) as any)
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
     * is a no-op. A crash here is contained to this utility process.
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

    private emitEvent (event: string, ...args: any[]): void {
        send({ t: 'event', id: this.id, event, args })
    }
}

const ptys = new Map<string, HostedPTY>()

port.on('message', (event: { data: PTYHostCommand }) => {
    const command = event.data
    switch (command.t) {
        case 'spawn':
            try {
                ptys.set(command.id, new HostedPTY(command.id, ...command.args))
            } catch (err) {
                send({ t: 'error', id: command.id, message: err instanceof Error ? err.message : String(err) })
            }
            break
        case 'write':
            ptys.get(command.id)?.write(command.data)
            break
        case 'resize':
            ptys.get(command.id)?.resize(command.cols, command.rows)
            break
        case 'ack':
            ptys.get(command.id)?.ackData(command.length)
            break
        case 'kill':
            ptys.get(command.id)?.kill(command.signal)
            break
        case 'ping':
            // Liveness probe: answer on the same event loop the PTYs run on, so
            // a blocked/hung host stops answering and the main process watchdog
            // can kill and restart it.
            send({ t: 'pong' })
            break
    }
})
