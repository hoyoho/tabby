import stripAnsi from 'strip-ansi'
import { IPCConnectionProxy, LogService, NotificationsService, TranslateService } from 'tabby-core'
import { Subject, Observable } from 'rxjs'
import { Injector } from '@angular/core'
import { BaseSession, ConnectableTerminalProfile, InputProcessingOptions, InputProcessor, LoginScriptsOptions, SessionMiddleware, StreamProcessingOptions, TerminalStreamProcessor, UTF8SplitterMiddleware } from 'tabby-terminal'
import { SerialService } from './services/serial.service'

export interface SerialProfile extends ConnectableTerminalProfile {
    options: SerialProfileOptions
}

export interface SerialProfileOptions extends StreamProcessingOptions, LoginScriptsOptions {
    port: string
    baudrate: number | null
    databits: 5 | 6 | 7 | 8
    stopbits: 1 | 1.5 | 2
    parity: string
    rtscts: boolean
    xon: boolean
    xoff: boolean
    xany: boolean
    slowSend: boolean
    input: InputProcessingOptions,
}

export const BAUD_RATES = [
    110, 150, 300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000,
]

export interface SerialPortInfo {
    name: string
    description?: string
}

/**
 * Paces terminal input at the port's line rate. The previous implementation
 * emitted one Buffer per byte with no delay, which multiplied Subject/IPC
 * traffic without slowing anything down.
 */
class SlowFeedMiddleware extends SessionMiddleware {
    private queue = Buffer.alloc(0)
    private timer: ReturnType<typeof setTimeout>|null = null
    private closed = false

    constructor (private bytesPerSecond: number) {
        super()
    }

    feedFromTerminal (data: Buffer): void {
        if (this.closed) {
            return
        }
        this.queue = Buffer.concat([this.queue, data])
        this.pump()
    }

    close (): void {
        this.closed = true
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
        this.queue = Buffer.alloc(0)
        super.close()
    }

    private pump (): void {
        if (this.timer !== null || this.closed || !this.queue.length) {
            return
        }
        // Timers are clamped to ~4ms; batch the bytes that would have gone out
        // in that window so low baud rates stay accurate.
        const delay = Math.max(4, Math.ceil(1000 / this.bytesPerSecond))
        const chunkSize = Math.max(1, Math.floor(this.bytesPerSecond * delay / 1000))
        this.timer = setTimeout(() => {
            this.timer = null
            if (this.closed || !this.queue.length) {
                return
            }
            const chunk = this.queue.slice(0, chunkSize)
            this.queue = this.queue.slice(chunkSize)
            this.outputToSession.next(chunk)
            this.pump()
        }, delay)
    }
}

type SerialPortEvent = 'open'|'data'|'end'|'error'|'close'

export interface SerialOpenOptions {
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
 * Renderer-side stand-in for the serial port. The real handle lives in the
 * Electron main process (`app/lib/serial.ts`) — exclusively-held COM ports
 * survive cross-window transfers because they are never re-opened. This proxy
 * only forwards IPC events, mirroring how local PTYs are accessed via
 * `ElectronPTYProxy`.
 */
export class SerialPortProxy extends IPCConnectionProxy<SerialPortEvent> {
    protected readonly protocol = 'serial'

    async connect (options: SerialOpenOptions): Promise<void> {
        await this.spawnAndAwaitOpen(options)
    }
}

export class SerialSession extends BaseSession {
    serial: SerialPortProxy|null

    get serviceMessage$ (): Observable<string> { return this.serviceMessage }
    private serviceMessage = new Subject<string>()
    private streamProcessor: TerminalStreamProcessor
    private notifications: NotificationsService
    private translate: TranslateService
    private serialService: SerialService
    private destroying = false

    /**
     * When set, destroy() releases the underlying main-process port without
     * closing it — the target window of a cross-window drag re-attaches it by
     * id, exactly like `keepPTYAlive` for local PTYs.
     */
    keepPTYAlive = false

    constructor (injector: Injector, public profile: SerialProfile) {
        super(injector.get(LogService).create(`serial-${profile.options.port}`))
        this.serialService = injector.get(SerialService)

        this.notifications = injector.get(NotificationsService)
        this.translate = injector.get(TranslateService)

        this.streamProcessor = new TerminalStreamProcessor(profile.options)
        this.middleware.push(this.streamProcessor)

        if (this.profile.options.slowSend) {
            // One character is ~10 bits on the wire (start + 8 data + stop).
            const bytesPerSecond = (this.profile.options.baudrate ?? 9600) / 10
            this.middleware.unshift(new SlowFeedMiddleware(bytesPerSecond))
        }

        this.middleware.push(new UTF8SplitterMiddleware())
        this.middleware.push(new InputProcessor(profile.options.input))

        this.setLoginScriptsOptions(profile.options)
    }

    async start (options?: { restoreFromPortID?: string|null }): Promise<void> {
        if (!this.profile.options.port) {
            this.profile.options.port = (await this.serialService.listPorts())[0].name
        }

        const serial = this.serial = new SerialPortProxy()

        serial.on('data', data => this.emitOutput(data as Buffer))
        serial.on('error', error => {
            this.notifications.error(error as string)
            this.destroy()
        })
        serial.on('end', () => {
            this.logger.info('Port ended')
            if (this.open) {
                this.destroy()
            }
        })
        serial.on('close', () => {
            this.emitServiceMessage(this.translate.instant('Port closed'))
            this.destroy()
        })

        if (options?.restoreFromPortID && await serial.tryRestore(options.restoreFromPortID)) {
            // Re-attached to the live main-process port after a cross-window
            // drag — skip open messaging and login scripts.
            this.open = true
            setTimeout(() => this.streamProcessor.start())
            return
        }

        const openOptions: SerialOpenOptions = {
            port: this.profile.options.port,
            baudrate: this.profile.options.baudrate,
            databits: this.profile.options.databits,
            stopbits: this.profile.options.stopbits,
            parity: this.profile.options.parity,
            rtscts: this.profile.options.rtscts,
            xon: this.profile.options.xon,
            xoff: this.profile.options.xoff,
            xany: this.profile.options.xany,
        }
        await serial.connect(openOptions)

        this.open = true
        setTimeout(() => this.streamProcessor.start())
        this.loginScriptProcessor?.executeUnconditionalScripts()
    }

    getID (): string|null {
        return this.serial?.getID() ?? null
    }

    write (data: Buffer): void {
        this.serial?.write(data)
    }

    async destroy (): Promise<void> {
        if (this.destroying) {
            return
        }
        this.destroying = true
        if (this.keepPTYAlive) {
            // Detach without closing the live main-process port so the target
            // window of a cross-window drag can re-attach it by id.
            this.serial?.detach()
            this.releaseRendererState()
            this.serial = null
            return
        }
        this.serviceMessage.complete()
        this.kill()
        await super.destroy()
        this.serial?.destroy()
        this.serial = null
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    resize (_, __) {
        this.streamProcessor.resize()
    }

    kill (_?: string): void {
        this.serial?.destroy()
    }

    emitServiceMessage (msg: string): void {
        this.serviceMessage.next(msg)
        this.logger.info(stripAnsi(msg))
    }

    async getChildProcesses (): Promise<any[]> {
        return []
    }

    async gracefullyKillProcess (): Promise<void> {
        this.kill('TERM')
    }

    supportsWorkingDirectory (): boolean {
        return false
    }

    async getWorkingDirectory (): Promise<string|null> {
        return null
    }
}
