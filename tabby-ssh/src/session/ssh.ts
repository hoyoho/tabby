import { IpcRendererEvent, ipcRenderer } from 'electron'
import { Injector } from '@angular/core'
import { ConfigService, TranslateService } from 'tabby-core'
import { Subject, Observable } from 'rxjs'
import { SSHProfile } from '../api'
import { SSHCallbackBridgeService } from '../services/sshCallbackBridge.service'
import { ForwardedPort } from './forwards'
import { SFTPSession } from './sftp'

export interface Prompt {
    prompt: string
    echo?: boolean
}

/**
 * Renderer-side UI object for one keyboard-interactive round. The auth loop
 * itself runs in the main process; this only collects the user's responses.
 */
export class KeyboardInteractivePrompt {
    readonly responses: string[] = []

    private _resolve: (value: string[]) => void
    private _reject: (reason: any) => void
    readonly promise = new Promise<string[]>((resolve, reject) => {
        this._resolve = resolve
        this._reject = reject
    })

    constructor (
        public name: string,
        public instruction: string,
        public prompts: Prompt[],
    ) {
        this.responses = new Array(this.prompts.length).fill('')
    }

    isAPasswordPrompt (index: number): boolean {
        return this.prompts[index].prompt.toLowerCase().includes('password') && !this.prompts[index].echo
    }

    respond (): void {
        this._resolve(this.responses)
    }

    reject (): void {
        this._reject(new Error('Keyboard-interactive auth rejected'))
    }
}

/**
 * Facade over a main-process-hosted SSH connection (`app/lib/ssh.ts`). The
 * russh client, port forwards and SFTP all live in the main process and
 * survive window closes; this object only mirrors their state and forwards
 * IPC events, exactly like `ElectronPTYProxy` does for local PTYs.
 */
export class SSHSession {
    open = false
    authUsername: string|null = null
    /** Truthy when the connection authenticated with a private key (WinSCP). */
    usedPrivateKey = false
    forwardedPorts: ForwardedPort[] = []

    /**
     * When set, destroy() releases the underlying main-process connection
     * without killing it — the target window of a cross-window drag re-attaches
     * it by id, exactly like `keepPTYAlive` for local PTYs.
     */
    keepPTYAlive = false

    get serviceMessage$ (): Observable<string> { return this.serviceMessage }
    get keyboardInteractivePrompt$ (): Observable<KeyboardInteractivePrompt> { return this.keyboardInteractivePrompt }
    get willDestroy$ (): Observable<void> { return this.willDestroy }

    private translate: TranslateService
    private config: ConfigService
    private bridge: SSHCallbackBridgeService
    private connId: string|null = null
    private wired = false
    private refCount = 0
    private destroyHandled = false
    private serviceMessage = new Subject<string>()
    private keyboardInteractivePrompt = new Subject<KeyboardInteractivePrompt>()
    private willDestroy = new Subject<void>()

    constructor (
        injector: Injector,
        public profile: SSHProfile,
    ) {
        this.translate = injector.get(TranslateService)
        this.config = injector.get(ConfigService)
        this.bridge = injector.get(SSHCallbackBridgeService)
    }

    /**
     * Claims an existing main-process connection (cross-window transfer).
     * Returns false if the connection is gone — caller falls back to a fresh
     * connect.
     */
    async attach (connectionId: string): Promise<boolean> {
        const snapshot: {
            open: boolean
            authUsername: string|null
            usedPrivateKey: boolean
            forwardedPorts: any[]
        }|null = ipcRenderer.sendSync('ssh:attach', connectionId)
        if (!snapshot) {
            return false
        }
        this.connId = connectionId
        this.wire()
        this.bridge.registerSession(connectionId, this)
        this.open = snapshot.open
        this.authUsername = snapshot.authUsername
        this.usedPrivateKey = snapshot.usedPrivateKey
        this.forwardedPorts = snapshot.forwardedPorts.map(fw => Object.assign(new ForwardedPort(), fw))
        return true
    }

    async start (options?: { jumpConnectionId?: string|null }): Promise<void> {
        // The profile password is a secret — it never crosses into the main
        // process; stored credentials are fetched through the callback bridge.
        // IPC needs structured-cloneable data: build an explicit whitelist of
        // plain fields instead of spreading the profile (whose `forwardedPorts`
        // and other runtime fields may hold class instances with methods).
        const o = this.profile.options
        const spawnOptions: any = {
            host: o.host,
            port: o.port,
            user: o.user,
            auth: o.auth ?? null,
            privateKeys: [...(o.privateKeys ?? [])],
            keepaliveInterval: o.keepaliveInterval,
            keepaliveCountMax: o.keepaliveCountMax,
            readyTimeout: o.readyTimeout ?? null,
            x11: !!o.x11,
            skipBanner: !!o.skipBanner,
            agentForward: !!o.agentForward,
            algorithms: o.algorithms ? JSON.parse(JSON.stringify(o.algorithms)) : undefined,
            proxyCommand: o.proxyCommand ?? null,
            socksProxyHost: o.socksProxyHost ?? null,
            socksProxyPort: o.socksProxyPort ?? null,
            httpProxyHost: o.httpProxyHost ?? null,
            httpProxyPort: o.httpProxyPort ?? null,
            forwardedPorts: (o.forwardedPorts ?? []).map(fw => ({
                type: fw.type,
                host: fw.host,
                port: fw.port,
                targetAddress: fw.targetAddress,
                targetPort: fw.targetPort,
                description: fw.description,
            })),
        }
        const configSnapshot = {
            agentType: this.config.store.ssh.agentType,
            agentPath: this.config.store.ssh.agentPath,
            x11Display: this.config.store.ssh.x11Display,
        }
        const id: string = ipcRenderer.sendSync('ssh:spawn', spawnOptions, configSnapshot, options?.jumpConnectionId ?? null)
        this.connId = id
        this.wire()
        this.bridge.registerSession(id, this)

        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                ipcRenderer.off(`ssh:${id}:opened`, onOpened)
                ipcRenderer.off(`ssh:${id}:connect-failed`, onFailed)
                ipcRenderer.off(`ssh:${id}:destroyed`, onDestroyed)
            }
            const onOpened = () => {
                cleanup()
                resolve()
            }
            const onFailed = (_e: IpcRendererEvent, message: string) => {
                cleanup()
                reject(new Error(message))
            }
            const onDestroyed = () => {
                cleanup()
                reject(new Error('Connection failed'))
            }
            ipcRenderer.on(`ssh:${id}:opened`, onOpened)
            ipcRenderer.on(`ssh:${id}:connect-failed`, onFailed)
            ipcRenderer.on(`ssh:${id}:destroyed`, onDestroyed)
        })

        this.open = true
        this.forwardedPorts = this.profile.options.forwardedPorts.map(fw => Object.assign(new ForwardedPort(), fw))
    }

    /** Spawns a fresh connection when this facade has none yet. */
    hasConnection (): boolean {
        return !!this.connId && !this.destroyHandled
    }

    getID (): string|null {
        return this.connId
    }

    emitServiceMessage (msg: string): void {
        this.serviceMessage.next(msg)
    }

    /** Bridge entry: surface a main-process keyboard-interactive round. */
    emitKeyboardInteractivePrompt (prompt: KeyboardInteractivePrompt): void {
        this.keyboardInteractivePrompt.next(prompt)
    }

    async openShellChannel (options: { x11: boolean, command?: string|null }): Promise<string> {
        return ipcRenderer.invoke('ssh:open-shell', this.connId, options)
    }

    async openSFTP (): Promise<SFTPSession> {
        return SFTPSession.create(this)
    }

    /** Internal: creates the SFTP context in the main process. */
    async createSFTPId (): Promise<string> {
        return ipcRenderer.invoke('ssh:sftp-open', this.connId)
    }

    /** Internal: notifies the proxy when its main-process SFTP context dies. */
    subscribeSFTPClosed (sftpId: string, cb: () => void): void {
        if (!this.connId) {
            return
        }
        const listener = (_e: IpcRendererEvent, closedId: string) => {
            if (closedId === sftpId) {
                cb()
            }
        }
        ipcRenderer.on(`ssh:${this.connId}:sftp-closed`, listener)
    }

    async addPortForward (fw: ForwardedPort): Promise<void> {
        const result = await ipcRenderer.invoke('ssh:forward-add', this.connId, {
            type: fw.type,
            host: fw.host,
            port: fw.port,
            targetAddress: fw.targetAddress,
            targetPort: fw.targetPort,
            description: fw.description,
        })
        if (!result.ok) {
            throw new Error(result.error)
        }
        if (!this.forwardedPorts.includes(fw)) {
            this.forwardedPorts.push(fw)
        }
    }

    async removePortForward (fw: ForwardedPort): Promise<void> {
        const result = await ipcRenderer.invoke('ssh:forward-remove', this.connId, {
            type: fw.type,
            host: fw.host,
            port: fw.port,
            targetAddress: fw.targetAddress,
            targetPort: fw.targetPort,
            description: fw.description,
        })
        if (!result.ok) {
            throw new Error(result.error)
        }
        this.forwardedPorts = this.forwardedPorts.filter(x => x !== fw)
    }

    ref (): void {
        this.refCount++
    }

    unref (): void {
        this.refCount--
        if (this.refCount === 0) {
            void this.destroy()
        }
    }

    /**
     * Tab moved to another window: drop one renderer ref without killing the
     * connection — the new window's facade re-attaches it by id.
     */
    releaseForTransfer (): void {
        this.refCount--
        if (this.refCount <= 0) {
            this.keepPTYAlive = true
            void this.destroy()
        }
    }

    async destroy (): Promise<void> {
        if (this.destroyHandled) {
            return
        }
        this.destroyHandled = true
        this.open = false
        this.willDestroy.next()
        this.willDestroy.complete()
        this.serviceMessage.complete()
        this.keyboardInteractivePrompt.complete()
        this.unwire()
        if (this.connId) {
            this.bridge.unregisterSession(this.connId)
            if (this.keepPTYAlive) {
                ipcRenderer.send('ssh:detach', this.connId)
            } else {
                ipcRenderer.send('ssh:kill', this.connId)
            }
        }
    }

    private ingestServiceMessage (msg: string|{ t: string, p?: Record<string, unknown> }): void {
        if (typeof msg === 'object') {
            this.serviceMessage.next(this.translate.instant(msg.t, msg.p))
        } else {
            this.serviceMessage.next(msg)
        }
    }

    /** The main process tore the connection down (disconnect/kill/grace). */
    private onConnectionDestroyed (): void {
        if (this.destroyHandled) {
            return
        }
        this.destroyHandled = true
        this.open = false
        this.unwire()
        this.willDestroy.next()
        this.willDestroy.complete()
        this.serviceMessage.complete()
        this.keyboardInteractivePrompt.complete()
        if (this.connId) {
            this.bridge.unregisterSession(this.connId)
        }
    }

    private wire (): void {
        if (this.wired || !this.connId) {
            return
        }
        this.wired = true
        ipcRenderer.on(`ssh:${this.connId}:service-message`, this.serviceListener)
        ipcRenderer.on(`ssh:${this.connId}:destroyed`, this.destroyedListener)
    }

    private unwire (): void {
        if (!this.wired || !this.connId) {
            return
        }
        this.wired = false
        ipcRenderer.off(`ssh:${this.connId}:service-message`, this.serviceListener)
        ipcRenderer.off(`ssh:${this.connId}:destroyed`, this.destroyedListener)
    }

    private serviceListener = (_e: IpcRendererEvent, msg: string|{ t: string, p?: Record<string, unknown> }) =>
        this.ingestServiceMessage(msg)

    private destroyedListener = () => this.onConnectionDestroyed()
}
