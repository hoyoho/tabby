import { Observable, Subject } from 'rxjs'
import { Logger } from 'tabby-core'
import { LoginScriptProcessor, LoginScriptsOptions } from './middleware/loginScriptProcessing'
import { OSCProcessor } from './middleware/oscProcessing'
import { SessionMiddlewareStack } from './api/middleware'

/**
 * A session object for a [[BaseTerminalTabComponent]]
 * Extend this to implement custom I/O and process management for your terminal tab
 */
export abstract class BaseSession {
    open: boolean
    readonly oscProcessor = new OSCProcessor()
    readonly middleware = new SessionMiddlewareStack()
    protected output = new Subject<string>()
    protected binaryOutput = new Subject<Buffer>()
    protected closed = new Subject<void>()
    protected destroyed = new Subject<void>()
    protected loginScriptProcessor: LoginScriptProcessor | null = null
    protected reportedCWD?: string
    protected titleCWD?: string
    private initialDataBuffer = Buffer.from('')
    private initialDataBufferReleased = false

    get output$ (): Observable<string> { return this.output }
    get binaryOutput$ (): Observable<Buffer> { return this.binaryOutput }
    get closed$ (): Observable<void> { return this.closed }
    get destroyed$ (): Observable<void> { return this.destroyed }

    constructor (protected logger: Logger) {
        this.middleware.push(this.oscProcessor)
        this.oscProcessor.cwdReported$.subscribe(cwd => {
            this.reportedCWD = cwd
        })
        this.oscProcessor.titleCWDReported$.subscribe(cwd => {
            this.titleCWD = cwd
        })

        this.middleware.outputToTerminal$.subscribe(data => {
            if (!this.initialDataBufferReleased) {
                this.initialDataBuffer = Buffer.concat([this.initialDataBuffer, data])
            } else {
                this.output.next(data.toString())
                this.binaryOutput.next(data)
            }
        })

        this.middleware.outputToSession$.subscribe(data => this.write(data))
    }

    feedFromTerminal (data: Buffer): void {
        this.middleware.feedFromTerminal(data)
    }

    protected emitOutput (data: Buffer): void {
        this.middleware.feedFromSession(data)
    }

    releaseInitialDataBuffer (): void {
        this.initialDataBufferReleased = true
        this.output.next(this.initialDataBuffer.toString())
        this.binaryOutput.next(this.initialDataBuffer)
        this.initialDataBuffer = Buffer.from('')
    }

    setLoginScriptsOptions (options: LoginScriptsOptions): void {
        const newProcessor = new LoginScriptProcessor(this.logger, options)
        if (this.loginScriptProcessor) {
            this.middleware.replace(this.loginScriptProcessor, newProcessor)
        } else {
            this.middleware.push(newProcessor)
        }
        this.loginScriptProcessor = newProcessor
    }

    async destroy (): Promise<void> {
        if (this.open) {
            this.logger.info('Destroying')
            this.open = false
            this.closed.next()
            this.destroyed.next()
            await this.gracefullyKillProcess()
        }
        this.middleware.close()
        this.closed.complete()
        this.destroyed.complete()
        this.output.complete()
        this.binaryOutput.complete()
    }

    /**
     * Releases renderer-side session state without killing the underlying
     * main-process session — the cross-window transfer path (`keepPTYAlive`):
     * the target window re-attaches the session by id.
     */
    protected releaseRendererState (): void {
        this.open = false
        this.middleware.close()
        this.closed.next()
        this.destroyed.next()
        this.closed.complete()
        this.destroyed.complete()
        this.output.complete()
        this.binaryOutput.complete()
    }

    /**
     * The working directory the shell has already told us about (OSC 7 or its
     * window title). Synchronous and side-effect free: use it where a
     * best-effort value is enough (e.g. a recovery-token snapshot) so nothing
     * ever blocks on [[getWorkingDirectory]]'s native probe, which can take
     * seconds.
     */
    getCachedWorkingDirectory (): string|null {
        return this.reportedCWD ?? this.titleCWD ?? null
    }

    abstract start (options: unknown): Promise<void>
    abstract resize (columns: number, rows: number): void
    abstract write (data: Buffer): void
    abstract kill (signal?: string): void
    abstract gracefullyKillProcess (): Promise<void>
    abstract supportsWorkingDirectory (): boolean
    abstract getWorkingDirectory (): Promise<string|null>
}
