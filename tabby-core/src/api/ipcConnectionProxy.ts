import { ipcRenderer, IpcRendererEvent } from 'electron'

/**
 * Renderer-side stand-in for a connection hosted in the Electron main process
 * (serial port, telnet socket, …). The real handle lives in the main process
 * (`app/lib/<protocol>.ts`) and survives cross-window transfers because it is
 * never re-opened; this proxy only forwards `<protocol>:<id>:*` IPC events,
 * mirroring how local PTYs are accessed via `ElectronPTYProxy`.
 */
export abstract class IPCConnectionProxy<Event extends string> {
    protected id: string|null = null
    private handlers = new Map<Event, Set<(...args: any[]) => void>>()
    private wiredChannels = new Set<string>()

    getID (): string|null {
        return this.id
    }

    on (event: Event, handler: (...args: any[]) => void): void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set())
        }
        this.handlers.get(event)!.add(handler)
    }

    /**
     * Claims an existing main-process connection (cross-window transfer).
     * Returns false if the connection is gone — caller falls back to a fresh
     * connect.
     */
    async tryRestore (id: string): Promise<boolean> {
        const ok: boolean = ipcRenderer.sendSync(`${this.protocol}:attach`, id)
        if (!ok) {
            return false
        }
        this.id = id
        this.wire()
        return true
    }

    write (data: Buffer): void {
        if (this.id) {
            ipcRenderer.send(`${this.protocol}:write`, this.id, data)
        }
    }

    /** Releases the connection without killing it (cross-window transfer). */
    detach (): void {
        if (this.id) {
            ipcRenderer.send(`${this.protocol}:detach`, this.id)
        }
        this.unsubscribeAll()
        this.id = null
    }

    destroy (): void {
        if (this.id) {
            ipcRenderer.send(`${this.protocol}:kill`, this.id)
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

    /** IPC namespace of the hosted connection, e.g. `'serial'`. */
    protected abstract readonly protocol: string

    /** Spawns the connection in the main process and waits for its open event. */
    protected async spawnAndAwaitOpen (...spawnArgs: any[]): Promise<void> {
        const id: string = ipcRenderer.sendSync(`${this.protocol}:spawn`, ...spawnArgs)
        this.id = id
        this.wire()
        await new Promise<void>((resolve, reject) => {
            const openHandler = () => {
                // eslint-disable-next-line @typescript-eslint/no-use-before-define
                cleanup()
                resolve()
            }
            const errorHandler = (_e: IpcRendererEvent, message: string) => {
                // eslint-disable-next-line @typescript-eslint/no-use-before-define
                cleanup()
                reject(new Error(message))
            }
            const cleanup = () => {
                ipcRenderer.off(`${this.protocol}:${id}:open`, openHandler)
                ipcRenderer.off(`${this.protocol}:${id}:error`, errorHandler)
            }
            ipcRenderer.on(`${this.protocol}:${id}:open`, openHandler)
            ipcRenderer.on(`${this.protocol}:${id}:error`, errorHandler)
        })
    }

    /** Hook after each delivered event batch — e.g. telnet acks data here. */
    protected afterEvent (_event: Event, _args: any[]): void { /* optional */ }

    private wire (): void {
        if (!this.id) {
            return
        }
        for (const [event, handlers] of this.handlers) {
            const channel = `${this.protocol}:${this.id}:${event}`
            if (this.wiredChannels.has(channel)) {
                continue
            }
            this.wiredChannels.add(channel)
            const listener = (_e: IpcRendererEvent, ...args: any[]) => {
                for (const handler of [...handlers]) {
                    handler(...args)
                }
                this.afterEvent(event, args)
            }
            // Keep a stable reference so removeAllListeners below only ever
            // touches channels this proxy owns.
            ipcRenderer.on(channel, listener)
        }
    }
}
