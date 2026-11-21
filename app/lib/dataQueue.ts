/**
 * Shared renderer-backpressure queue for main-process data streams.
 *
 * Data is buffered and released in bounded chunks while the unacked in-flight
 * window stays under `maxInFlight`; beyond that, producers hold back until the
 * renderer acks. The optional `pause`/`resume` hooks let a native producer
 * (node-pty) participate in the same flow control.
 */
export interface DataQueueOptions {
    /** Maximum bytes emitted to the renderer in one chunk. */
    maxChunk?: number
    /** Maximum unacked bytes before the producer is paused. */
    maxInFlight?: number
    /** Transforms a raw chunk before it is handed to the renderer. */
    transform?: (data: Buffer) => Buffer
    pause?: () => void
    resume?: () => void
}

export class DataQueue {
    private buffers: Buffer[] = []
    private inFlight = 0
    private stopped = false
    private paused = false
    private readonly maxChunk: number
    private readonly maxInFlight: number

    constructor (
        private onData: (data: Buffer) => void,
        private options: DataQueueOptions = {},
    ) {
        this.maxChunk = options.maxChunk ?? 1024 * 100
        this.maxInFlight = options.maxInFlight ?? this.maxChunk * 5
    }

    push (data: Uint8Array): void {
        if (this.stopped) {
            return
        }
        this.buffers.push(Buffer.from(data))
        this.maybeEmit()
    }

    ack (length: number): void {
        if (this.stopped) {
            return
        }
        this.inFlight = Math.max(0, this.inFlight - length)
        this.maybeEmit()
    }

    stop (): void {
        this.stopped = true
        this.buffers = []
    }

    private maybeEmit (): void {
        if (this.stopped) {
            return
        }
        if (this.inFlight > this.maxInFlight) {
            if (!this.paused) {
                this.paused = true
                this.options.pause?.()
            }
            return
        }
        if (this.paused) {
            this.paused = false
            this.options.resume?.()
        }
        if (!this.buffers.length) {
            return
        }

        const buffersToSend: Buffer[] = []
        let totalLength = 0
        while (totalLength < this.maxChunk && this.buffers.length) {
            totalLength += this.buffers[0].length
            buffersToSend.push(this.buffers.shift()!)
        }

        let toSend = Buffer.concat(buffersToSend)
        if (toSend.length > this.maxChunk) {
            this.buffers.unshift(toSend.slice(this.maxChunk))
            toSend = toSend.slice(0, this.maxChunk)
        }

        const payload = this.options.transform ? this.options.transform(toSend) : toSend
        this.inFlight += toSend.length
        this.onData(payload)

        // Always let the next tick observe the window, so a producer with
        // pause/resume hooks (node-pty) is paused once it is exceeded.
        if (this.buffers.length) {
            setImmediate(() => this.maybeEmit())
        }
    }
}
