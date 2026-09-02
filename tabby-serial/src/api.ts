import { IpcRendererEvent, ipcRenderer } from 'electron'
import stripAnsi from 'strip-ansi'
import { LogService, NotificationsService, TranslateService } from 'tabby-core'
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

class SlowFeedMiddleware extends SessionMiddleware {
    feedFromTerminal (data: Buffer): void {
        for (const byte of data) {
            this.outputToSession.next(Buffer.from([byte]))
        }
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
export class SerialPortProxy {
    private id: string|null = null
    private handlers = new Map<SerialPortEvent, Set<(...args: any[]) => void>>()
    private wiredChannels = new Set<string>()

    getID (): string|null {
        return this.id
    }

    on (event: SerialPortEvent, handler: (...args: any[]) => void): void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set())
        }
        this.handlers.get(event)!.add(handler)
    }

    /**
     * Claims an existing main-process connection (cross-window transfer).
     * Returns false if the connection is gone — caller falls back to a fresh
     * open.
     */
    async tryRestore (id: string): Promise<boolean> {
        const ok: boolean = ipcRenderer.sendSync('serial:attach', id)
        if (!ok) {
            return false
        }
        this.id = id
        this.wire()
        return true
    }

    async connect (options: SerialOpenOptions): Promise<void> {
        const id: string = ipcRenderer.sendSync('serial:spawn', options)
        this.id = id
        this.wire()
        await new Promise<void>((resolve, reject) => {
            const openHandler = () => {
                cleanup()
                resolve()
            }
            const errorHandler = (_e: IpcRendererEvent, message: string) => {
                cleanup()
                reject(new Error(message))
            }
            ipcRenderer.on(`serial:${id}:open`, openHandler)
            ipcRenderer.on(`serial:${id}:error`, errorHandler)
            const cleanup = () => {
                ipcRenderer.off(`serial:${id}:open`, openHandler)
                ipcRenderer.off(`serial:${id}:error`, errorHandler)
            }
        })
    }

    write (data: Buffer): void {
        if (this.id) {
            ipcRenderer.send('serial:write', this.id, data)
        }
    }

    update (options: { baudRate: number }): void {
        if (this.id) {
            ipcRenderer.send('serial:update', this.id, options)
        }
    }

    /** Releases the port without closing it (cross-window transfer). */
    detach (): void {
        if (this.id) {
            ipcRenderer.send('serial:detach', this.id)
        }
        this.unsubscribeAll()
        this.id = null
    }

    destroy (): void {
        if (this.id) {
            ipcRenderer.send('serial:kill', this.id)
        }
        this.unsubscribeAll()
        this.id = null
    }

    unsubscribeAll (): void {
        for (const channel of this.wiredChannels) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ipcRenderer.removeAllListeners(channel as any)
        }
        this.wiredChannels.clear()
    }

    private wire (): void {
        if (!this.id) {
            return
        }
        for (const [event, handlers] of this.handlers) {
            const channel = `serial:${this.id}:${event}`
            if (this.wiredChannels.has(channel)) {
                continue
            }
            this.wiredChannels.add(channel)
            const listener = (_e: IpcRendererEvent, ...args: any[]) => {
                for (const handler of [...handlers]) {
                    handler(...args)
                }
            }
            // Keep a stable reference so removeAllListeners below only ever
            // touches channels this proxy owns.
            ipcRenderer.on(channel, listener)
        }
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
            this.middleware.unshift(new SlowFeedMiddleware())
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
            this.open = false
            this.middleware.close()
            this.closed.next()
            this.destroyed.next()
            this.closed.complete()
            this.destroyed.complete()
            this.output.complete()
            this.binaryOutput.complete()
            this.serial = null
            return
        }
        this.serviceMessage.complete()
        this.kill()
        await super.destroy()
        this.serial?.destroy()
        this.serial = null
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-empty-function
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
