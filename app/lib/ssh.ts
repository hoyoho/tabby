import * as fs from 'fs'
import * as net from 'net'
import * as crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain, webContents } from 'electron'
import { Application } from './app'
import { SSHAlgorithmType, supportedAlgorithms } from './sshAlgorithms'
import * as russh from 'russh'
import socksv5 from '@luminati-io/socksv5'
import * as shellQuote from 'shell-quote'

/**
 * How long a connection with zero attached renderers survives. Covers the
 * cross-window drag race: the source window detaches before the target window
 * attaches, and a dropped/failed transfer must not leak an open connection.
 */
const GRACE_PERIOD_MS = 10000

const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

// Minimal ANSI helpers — the service messages keep the same look as the old
// renderer-side ansi-colors output without pulling the dependency in.
/* eslint-disable no-useless-concat */
const ansi = (codes: number[], text: string): string => `\x1b[${codes.join(';')}m${text}\x1b[0m`
const MSG_X = ansi([41, 30], ' X ')
const MSG_WARN = ansi([43, 33], ' ! ')
const MSG_PROXY_COMMAND = ansi([44, 30], ' Proxy command ')
const MSG_PROXY = ansi([44, 30], ' Proxy ')
const MSG_FWD_OK_LOCAL = ansi([42, 30], ' -> ')
const MSG_FWD_OK_REMOTE = ansi([42, 30], ' <- ')
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

/** A service message that still needs renderer-side translation. */
export interface TranslatableMessage {
    t: string
    p?: Record<string, unknown>
}

/** Subset of `config.store.ssh` the main process needs. Secrets stay out. */
export interface SSHConfigSnapshot {
    agentType: string
    agentPath?: string
    x11Display?: string
}

/** Profile options minus secrets (`password` is stripped renderer-side). */
export interface SSHConnectionOptions {
    host: string
    port?: number
    user: string
    auth: null|'password'|'publicKey'|'agent'|'keyboardInteractive'
    privateKeys: string[]
    keepaliveInterval: number
    keepaliveCountMax: number
    readyTimeout: number | null
    x11: boolean
    skipBanner: boolean
    agentForward: boolean
    algorithms: Record<SSHAlgorithmType, string[]>
    proxyCommand: string | null
    forwardedPorts: ForwardedPortConfig[]
    socksProxyHost: string | null
    socksProxyPort: number | null
    httpProxyHost: string | null
    httpProxyPort: number | null
}

export interface ForwardedPortConfig {
    type: 'Local'|'Remote'|'Dynamic'
    host: string
    port: number
    targetAddress: string
    targetPort: number
    description: string
}

export interface PromptPayload {
    msgid: string
    params?: Record<string, unknown>
    password: boolean
    showRememberCheckbox?: boolean
    value?: string|null
}

export interface PromptSpec {
    prompt: string
    echo?: boolean
}

type AuthMethod = {
    type: 'none'|'prompt-password'|'hostbased'
} | {
    type: 'keyboard-interactive',
    savedPassword?: string
} | {
    type: 'saved-password',
    password: string
} | {
    type: 'publickey'
    name: string
    contents: Buffer
} | ({
    type: 'agent',
    publicKey?: russh.SshPublicKey
} & ({
    kind: 'unix-socket',
    path: string
} | {
    kind: 'named-pipe',
    path: string
} | {
    kind: 'pageant',
}))

function sshAuthTypeForMethod (m: AuthMethod): string {
    switch (m.type) {
        case 'none': return 'none'
        case 'hostbased': return 'hostbased'
        case 'prompt-password': return 'password'
        case 'saved-password': return 'password'
        case 'keyboard-interactive': return 'keyboard-interactive'
        case 'publickey': return 'publickey'
        case 'agent': return 'publickey'
    }
}

interface PendingCallback {
    method: string
    args: any[]
    resolve: (value: any) => void
    reject: (reason: any) => void
}

/**
 * Bounds in-flight IPC output per channel. Unlike the PTY queue there is no
 * native pause; we simply stop draining until the renderer acks.
 */
class ChannelDataQueue {
    private buffers: Buffer[] = []
    private delta = 0
    private maxChunk = 1024 * 100
    private maxDelta = this.maxChunk * 5
    private stopped = false

    constructor (private emit: (data: Buffer) => void) { }

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
        this.delta -= length
        this.maybeEmit()
    }

    stop (): void {
        this.stopped = true
        this.buffers = []
    }

    private maybeEmit (): void {
        if (this.stopped || !this.buffers.length) {
            return
        }
        if (this.delta > this.maxDelta) {
            return
        }
        const buffersToSend = []
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
        this.delta += toSend.length
        this.emit(toSend)
        if (this.buffers.length && this.delta <= this.maxDelta) {
            setImmediate(() => this.maybeEmit())
        }
    }
}

interface ChannelEntry {
    id: string
    channel: russh.Channel
    queue: ChannelDataQueue
}

interface SFTPEntry {
    id: string
    sftp: russh.SFTP
    handles: Map<string, russh.SFTPFile>
}

/** Local TCP listener for a forwarded port; lives in the main process. */
class ForwardedPort implements ForwardedPortConfig {
    type: ForwardedPortConfig['type']
    host = '127.0.0.1'
    port: number
    targetAddress: string
    targetPort: number
    description: string

    private listener: net.Server|null = null

    async startLocalListener (callback: (accept: () => net.Socket, reject: () => void, sourceAddress: string|null, sourcePort: number|null, targetAddress: string, targetPort: number) => void): Promise<void> {
        if (this.type === 'Local') {
            const listener = this.listener = net.createServer(s => callback(
                () => s,
                () => s.destroy(),
                s.remoteAddress ?? null,
                s.remotePort ?? null,
                this.targetAddress,
                this.targetPort,
            ))
            return new Promise((resolve, reject) => {
                listener.listen(this.port, this.host)
                listener.on('error', reject)
                listener.on('listening', resolve)
            })
        } else if (this.type === 'Dynamic') {
            return new Promise((resolve, reject) => {
                this.listener = socksv5.createServer((info, acceptConnection, rejectConnection) => {
                    callback(
                        () => acceptConnection(true),
                        () => rejectConnection(),
                        null,
                        null,
                        info.dstAddr,
                        info.dstPort,
                    )
                }) as net.Server
                this.listener.on('error', reject)
                this.listener.listen(this.port, this.host, resolve)
                // eslint-disable-next-line dot-notation
                this.listener['useAuth'](socksv5.auth.None())
            })
        } else {
            throw new Error('Invalid forward type for a local listener')
        }
    }

    stopLocalListener (): void {
        this.listener?.close()
    }

    toString (): string {
        if (this.type === 'Local') {
            return `(local) ${this.host}:${this.port} → (remote) ${this.targetAddress}:${this.targetPort}`
        } if (this.type === 'Remote') {
            return `(remote) ${this.host}:${this.port} → (local) ${this.targetAddress}:${this.targetPort}`
        } else {
            return `(dynamic) ${this.host}:${this.port}`
        }
    }
}

/** X11 display spec resolution, ported from tabby-ssh/src/session/x11.ts. */
function resolveX11DisplaySpec (spec?: string|null): net.SocketConnectOpts {
    // eslint-disable-next-line prefer-const, @typescript-eslint/no-unused-vars
    let [_, xHost, xDisplay] = /^(.+):(\d+)(?:.(\d+))$/.exec(spec ?? process.env.DISPLAY ?? 'localhost:0') ?? [undefined, undefined, undefined]
    if (process.platform === 'win32') {
        xHost ??= 'localhost'
    } else {
        xHost ??= 'unix'
    }

    if (spec?.startsWith('/')) {
        xHost = spec
    }

    const display = parseInt(xDisplay ?? '0')
    const port = display < 100 ? display + 6000 : display

    if (xHost === 'unix') {
        xHost = `/tmp/.X11-unix/X${display}`
    }

    if (xHost.startsWith('/')) {
        return { path: xHost }
    } else {
        return { host: xHost, port }
    }
}

/**
 * Main-process host for one live SSH connection. Everything the old
 * renderer-side SSHSession did with russh happens here now; all renderer
 * services (modals, password storage, known hosts, file providers) are
 * reached through the `ssh:cb` callback bridge targeting the owner window.
 */
class SSHConnection {
    closed = false
    open = false
    attachers = new Set<number>()
    dependents = new Set<string>()
    owner: number|null = null
    client: russh.SSHClient|russh.AuthenticatedSSHClient|null = null
    /** Truthy snapshot for launchWinSCP (russh KeyPair cannot cross IPC). */
    activePrivateKey = false
    authUsername: string|null = null

    private channels = new Map<string, ChannelEntry>()
    private sftps = new Map<string, SFTPEntry>()
    private pendingCallbacks = new Map<string, PendingCallback>()
    private forwardedPorts: ForwardedPort[] = []
    private savedPassword?: string
    private graceTimer: NodeJS.Timeout|null = null
    private destroying = false

    constructor (
        private id: string,
        private app: Application,
        private manager: SSHConnectionManager,
        private options: SSHConnectionOptions,
        private config: SSHConfigSnapshot,
        private jumpConnectionId: string|null,
    ) {
        if (jumpConnectionId) {
            this.manager.getConnection(jumpConnectionId)?.dependents.add(id)
        }
    }

    private emit (event: string, ...args: any[]): void {
        this.app.broadcast(`ssh:${this.id}:${event}`, ...args)
    }

    // ── UI callback bridge ────────────────────────────────────────────────

    private request (method: string, ...args: any[]): Promise<any> {
        return new Promise((resolve, reject) => {
            const cbId = uuidv4()
            const pending: PendingCallback = { method, args, resolve, reject }
            this.pendingCallbacks.set(cbId, pending)
            this.deliverCallback(cbId, pending)
        })
    }

    private deliverCallback (cbId: string, pending: PendingCallback): void {
        if (this.owner == null) {
            return
        }
        const wc = webContents.getAllWebContents().find(w => w.id === this.owner && !w.isDestroyed())
        wc?.send('ssh:cb', this.id, cbId, pending.method, ...pending.args)
    }

    handleCallbackResponse (cbId: string, payload: { ok: boolean, result?: any, error?: string }): void {
        const pending = this.pendingCallbacks.get(cbId)
        if (!pending) {
            return
        }
        this.pendingCallbacks.delete(cbId)
        if (payload.ok) {
            pending.resolve(payload.result)
        } else {
            pending.reject(new Error(payload.error ?? 'Callback failed'))
        }
    }

    /** After a cross-window attach the new owner must see pending prompts. */
    resendPendingCallbacks (): void {
        for (const [cbId, pending] of this.pendingCallbacks) {
            this.deliverCallback(cbId, pending)
        }
    }

    private rejectPendingCallbacks (reason: string): void {
        for (const pending of this.pendingCallbacks.values()) {
            pending.reject(new Error(reason))
        }
        this.pendingCallbacks.clear()
    }

    private emitServiceMessage (msg: string|TranslatableMessage): void {
        this.emit('service-message', msg)
        if (typeof msg === 'string') {
            console.info(`[ssh] ${stripAnsi(msg)}`)
        }
    }

    // ── connection lifecycle ──────────────────────────────────────────────

    async connect (): Promise<void> {
        try {
            await this.connectInner()
            this.open = true
            this.emit('opened')
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            this.emit('connect-failed', message)
            setImmediate(() => this.destroy())
        }
    }

    // eslint-disable-next-line max-statements
    private async connectInner (): Promise<void> {
        const options = this.options
        const allAuthMethods = await this.initAuthMethods()

        if (!options.algorithms) {
            throw new Error('No algorithms configured')
        }

        // eslint-disable-next-line @typescript-eslint/init-declarations
        let transport: russh.SshTransport
        if (options.proxyCommand) {
            this.emitServiceMessage(`${MSG_PROXY_COMMAND} Using ${options.proxyCommand}`)
            const argv = shellQuote.parse(options.proxyCommand) as string[]
            transport = await russh.SshTransport.newCommand(argv[0], argv.slice(1))
        } else if (this.jumpConnectionId) {
            const jump = this.manager.getConnection(this.jumpConnectionId)
            if (!jump || !(jump.client instanceof russh.AuthenticatedSSHClient)) {
                throw new Error('Jump connection is not authenticated')
            }
            const channel = await jump.client.openTCPForwardChannel({
                addressToConnectTo: options.host,
                portToConnectTo: options.port ?? 22,
                originatorAddress: '127.0.0.1',
                originatorPort: 0,
            })
            transport = await russh.SshTransport.newSshChannel(channel.take())
        } else if (options.socksProxyHost) {
            this.emitServiceMessage(`${MSG_PROXY} Using ${options.socksProxyHost}:${options.socksProxyPort}`)
            transport = await russh.SshTransport.newSocksProxy(
                options.socksProxyHost,
                options.socksProxyPort ?? 1080,
                options.host,
                options.port ?? 22,
            )
        } else if (options.httpProxyHost) {
            this.emitServiceMessage(`${MSG_PROXY} Using ${options.httpProxyHost}:${options.httpProxyPort}`)
            transport = await russh.SshTransport.newHttpProxy(
                options.httpProxyHost,
                options.httpProxyPort ?? 8080,
                options.host,
                options.port ?? 22,
            )
        } else {
            transport = await russh.SshTransport.newSocket(`${options.host.trim()}:${options.port ?? 22}`)
        }

        this.client = await russh.SSHClient.connect(
            transport,
            async key => this.verifyHostKey(key),
            {
                preferred: {
                    ciphers: options.algorithms[SSHAlgorithmType.CIPHER].filter(x => supportedAlgorithms[SSHAlgorithmType.CIPHER].includes(x)),
                    kex: options.algorithms[SSHAlgorithmType.KEX].filter(x => supportedAlgorithms[SSHAlgorithmType.KEX].includes(x)),
                    mac: options.algorithms[SSHAlgorithmType.HMAC].filter(x => supportedAlgorithms[SSHAlgorithmType.HMAC].includes(x)),
                    key: options.algorithms[SSHAlgorithmType.HOSTKEY].filter(x => supportedAlgorithms[SSHAlgorithmType.HOSTKEY].includes(x)),
                    compression: options.algorithms[SSHAlgorithmType.COMPRESSION].filter(x => supportedAlgorithms[SSHAlgorithmType.COMPRESSION].includes(x)),
                },
                keepaliveIntervalSeconds: options.keepaliveInterval ? Math.round(options.keepaliveInterval / 1000) : undefined,
                keepaliveCountMax: options.keepaliveCountMax,
                connectionTimeoutSeconds: options.readyTimeout ? Math.round(options.readyTimeout / 1000) : undefined,
            },
        )

        this.client.banner$.subscribe(banner => {
            if (!options.skipBanner) {
                this.emitServiceMessage(banner)
            }
        })

        let previouslyDisconnected = false
        this.client.disconnect$.subscribe(() => {
            if (!previouslyDisconnected) {
                previouslyDisconnected = true
                // Let service messages drain
                setTimeout(() => this.destroy())
            }
        })

        // Username

        this.authUsername ??= options.user
        if (!this.authUsername) {
            const result = await this.request('prompt', {
                msgid: 'Username for {host}',
                params: { host: options.host },
                password: false,
            } as PromptPayload)
            this.authUsername = result?.value ?? null
        }

        if (this.authUsername?.startsWith('$')) {
            try {
                this.authUsername = process.env[this.authUsername.slice(1)] ?? this.authUsername
            } catch {
                this.authUsername = 'root'
            }
        }

        // Stored password for the resolved username

        if (this.authUsername) {
            const storedPassword = await this.request('load-password', { username: this.authUsername })
            if (storedPassword) {
                this.populateStoredPassword(allAuthMethods, storedPassword)
            }
        }

        const authenticatedClient = await this.handleAuth(allAuthMethods)
        if (authenticatedClient) {
            this.client = authenticatedClient
        } else {
            try {
                this.client.disconnect()
            } catch { /* ignore */ }
            await this.request('delete-password', { username: this.authUsername })
            throw new Error('Authentication rejected')
        }

        // Auth success

        if (this.savedPassword) {
            await this.request('save-password', { password: this.savedPassword, username: this.authUsername })
        }

        for (const fw of options.forwardedPorts) {
            await this.addPortForward(new ForwardedPortHost(fw))
        }

        this.setupChannelPumps()
    }

    private populateStoredPassword (methods: AuthMethod[], storedPassword: string): void {
        const auth = this.options.auth
        if (!auth || auth === 'password') {
            const hasSavedPassword = methods.some(m => m.type === 'saved-password' && m.password === storedPassword)
            if (!hasSavedPassword) {
                const promptIndex = methods.findIndex(m => m.type === 'prompt-password')
                const insertIndex = promptIndex >= 0 ? promptIndex : methods.length
                methods.splice(insertIndex, 0, { type: 'saved-password', password: storedPassword })
            }
        }
        if (!auth || auth === 'keyboardInteractive') {
            const existingSaved = methods.find(m => m.type === 'keyboard-interactive' && m.savedPassword === storedPassword)
            if (!existingSaved) {
                const updatable = methods.find(m => m.type === 'keyboard-interactive' && m.savedPassword === undefined)
                if (updatable && updatable.type === 'keyboard-interactive') {
                    updatable.savedPassword = storedPassword
                } else {
                    methods.push({ type: 'keyboard-interactive', savedPassword: storedPassword })
                }
            }
        }
    }

    // eslint-disable-next-line max-statements
    private async initAuthMethods (): Promise<AuthMethod[]> {
        const methods: AuthMethod[] = [{ type: 'none' }]
        const options = this.options
        if (!options.auth || options.auth === 'publicKey') {
            if (options.privateKeys.length) {
                for (let pk of options.privateKeys) {
                    pk = pk.replace('%h', options.host)
                    pk = pk.replace('%r', options.user)
                    const contents = await this.request('retrieve-file', { path: pk })
                    if (!contents) {
                        this.emitServiceMessage(`${MSG_WARN} Could not load private key ${pk}`)
                        continue
                    }
                    const buffer = Buffer.from(contents)

                    // If the file parses as a public key, it was likely a .pub
                    // file mistakenly configured in the privateKeys list.
                    try {
                        russh.parsePublicKey(buffer.toString('utf-8'))
                        this.emitServiceMessage(
                            `${MSG_WARN} Expected a private key, but ${pk} appears to be a public key. Skipping it for private key authentication.`,
                        )
                        continue
                    } catch {
                        // Not a valid public key; treat the contents as a private key below.
                    }

                    methods.push({ type: 'publickey', name: pk, contents: buffer })
                }
            } else {
                // Auto key discovery stays renderer-side (plugin importers).
                const keys: Array<{ name: string, contents: ArrayLike<number> }> = await this.request('locate-private-keys')
                for (const key of keys) {
                    methods.push({ type: 'publickey', name: key.name, contents: Buffer.from(key.contents) })
                }
            }
        }

        if (!options.auth || options.auth === 'agent') {
            const spec = await this.getAgentConnectionSpec()
            if (spec) {
                if (options.privateKeys.length) {
                    for (let pk of options.privateKeys) {
                        pk = pk.replace('%h', options.host)
                        pk = pk.replace('%r', options.user)
                        const pubKeyPath = pk.endsWith('.pub') ? pk : pk + '.pub'
                        const pubKeyContent = await this.request('retrieve-file', { path: pubKeyPath })
                        if (pubKeyContent) {
                            try {
                                const publicKey = russh.parsePublicKey(Buffer.from(pubKeyContent).toString('utf-8'))
                                methods.push({ type: 'agent', ...spec, publicKey } as AuthMethod)
                                this.emitServiceMessage(`Loaded public key for agent auth: ${pubKeyPath}`)
                            } catch {
                                this.emitServiceMessage(`Could not load public key for agent auth from ${pubKeyPath}`)
                            }
                        } else {
                            this.emitServiceMessage(`Could not load public key for agent auth from ${pubKeyPath}`)
                        }
                    }
                }
                methods.push({ type: 'agent', ...spec })
            }
        }
        if (!options.auth || options.auth === 'password') {
            // `password` was stripped from the profile before spawn — the saved
            // profile password arrives via load-password above instead.
        }
        if (!options.auth || options.auth === 'keyboardInteractive') {
            methods.push({ type: 'keyboard-interactive' })
            methods.push({ type: 'prompt-password' })
        }
        if (!options.auth || options.auth === 'password') {
            methods.push({ type: 'prompt-password' })
        }
        methods.push({ type: 'hostbased' })
        return methods
    }

    // eslint-disable-next-line max-statements
    private async getAgentConnectionSpec (): Promise<russh.AgentConnectionSpec|null> {
        if (process.platform === 'win32') {
            const agentType = this.config.agentType
            if (agentType === 'auto') {
                let pipeExists = false
                try {
                    await fs.promises.stat(WINDOWS_OPENSSH_AGENT_PIPE)
                    pipeExists = true
                } catch (e: any) {
                    if (e?.code === 'EBUSY') {
                        pipeExists = true
                    }
                }

                if (pipeExists) {
                    return { kind: 'named-pipe', path: WINDOWS_OPENSSH_AGENT_PIPE }
                } else if (russh.isPageantRunning()) {
                    return { kind: 'pageant' }
                } else {
                    this.emitServiceMessage(`${MSG_WARN} Agent auth selected, but no running Agent process is found`)
                }
            } else if (agentType === 'pageant') {
                return { kind: 'pageant' }
            } else {
                return { kind: 'named-pipe', path: this.config.agentPath || WINDOWS_OPENSSH_AGENT_PIPE }
            }
        } else {
            const configuredPath = (this.config.agentPath ?? '').trim()
            const envPath = (process.env.SSH_AUTH_SOCK ?? '').trim()
            const agentSocketPath = configuredPath || envPath

            if (!agentSocketPath) {
                this.emitServiceMessage(`${MSG_WARN} Agent auth selected, but SSH_AUTH_SOCK is not set`)
                return null
            }

            // Skip filesystem checks for abstract namespace sockets.
            if (!agentSocketPath.startsWith('@')) {
                try {
                    const stat = await fs.promises.stat(agentSocketPath)
                    if (!stat.isSocket()) {
                        this.emitServiceMessage(`${MSG_WARN} Agent socket path is not a Unix socket: ${agentSocketPath}`)
                        return null
                    }
                } catch (e) {
                    this.emitServiceMessage(`${MSG_WARN} Could not access agent socket ${agentSocketPath}: ${e}`)
                    return null
                }
            }

            return { kind: 'unix-socket', path: agentSocketPath }
        }
        return null
    }

    private async verifyHostKey (key: russh.SshPublicKey): Promise<boolean> {
        this.emitServiceMessage('Host key fingerprint:')
        this.emitServiceMessage(ansi([47, 37], ` ${key.algorithm()} `) + ansi([100], ` ${key.fingerprint()} `))
        const digest = crypto.createHash('sha256').update(key.bytes()).digest('base64')
        return this.request('host-key', {
            selector: {
                host: this.options.host,
                port: this.options.port ?? 22,
                type: key.algorithm(),
            },
            digest,
        })
    }

    // eslint-disable-next-line max-statements
    private async handleAuth (allAuthMethods: AuthMethod[]): Promise<russh.AuthenticatedSSHClient|null> {
        let client = this.client
        if (!(client instanceof russh.SSHClient)) {
            throw new Error('Wrong state for auth handling')
        }
        if (!this.authUsername) {
            throw new Error('No username')
        }

        client.disconnect$.subscribe(() => {
            // Auto auth and >=3 keys found
            if (!this.options.auth && allAuthMethods.filter(x => x.type === 'publickey').length >= 3) {
                this.emitServiceMessage('The server has disconnected during authentication.')
                this.emitServiceMessage('This may happen if too many private key authentication attemps are made.')
                this.emitServiceMessage('You can set the specific private key for authentication in the profile settings.')
            }
        })

        const noneResult = await client.authenticateNone(this.authUsername)
        if (noneResult instanceof russh.AuthenticatedSSHClient) {
            return noneResult
        }

        let remainingMethods = [...allAuthMethods]
        let methodsLeft = noneResult.remainingMethods

        function maybeSetRemainingMethods (r: russh.AuthFailure) {
            if (r.remainingMethods.length) {
                methodsLeft = r.remainingMethods
            }
        }

        while (true) {
            const m = methodsLeft
            const method = remainingMethods.find(x => m.length === 0 || m.includes(sshAuthTypeForMethod(x)))

            if (!method || this.closed) {
                return null
            }

            remainingMethods = remainingMethods.filter(x => x !== method)

            if (method.type === 'saved-password') {
                this.emitServiceMessage({ t: 'Using saved password' })
                const result = await (client as russh.SSHClient).authenticateWithPassword(this.authUsername!, method.password)
                if (result instanceof russh.AuthenticatedSSHClient) {
                    return result
                }
                maybeSetRemainingMethods(result)
            }
            if (method.type === 'prompt-password') {
                const prefilledPassword = await this.request('load-password', { username: this.authUsername })
                const promptResult = await this.request('prompt', {
                    msgid: 'Password for {user}@{host}',
                    params: {
                        user: this.authUsername,
                        host: this.options.host,
                    },
                    password: true,
                    // In keyboard-interactive mode this prompt is only a
                    // fallback when the server doesn't offer k-i; don't offer
                    // to remember the password there.
                    showRememberCheckbox: this.options.auth !== 'keyboardInteractive',
                    value: prefilledPassword,
                } as PromptPayload)
                if (promptResult) {
                    if (promptResult.remember) {
                        this.savedPassword = promptResult.value
                    }
                    const result = await (client as russh.SSHClient).authenticateWithPassword(this.authUsername!, promptResult.value)
                    if (result instanceof russh.AuthenticatedSSHClient) {
                        return result
                    }
                    maybeSetRemainingMethods(result)
                } else {
                    continue
                }
            }
            if (method.type === 'publickey') {
                try {
                    const key = await this.loadPrivateKey(method.name, method.contents)
                    this.emitServiceMessage(`Trying private key: ${method.name}`)
                    this.activePrivateKey = true
                    const result = await (client as russh.SSHClient).authenticateWithKeyPair(this.authUsername!, key, null)
                    if (result instanceof russh.AuthenticatedSSHClient) {
                        return result
                    }
                    maybeSetRemainingMethods(result)
                } catch (e) {
                    this.emitServiceMessage(`${MSG_WARN} Failed to load private key ${method.name}: ${e}`)
                    continue
                }
            }
            if (method.type === 'keyboard-interactive') {
                let state: russh.AuthenticatedSSHClient|russh.KeyboardInteractiveAuthenticationState =
                    await (client as russh.SSHClient).startKeyboardInteractiveAuthentication(this.authUsername!)

                while (true) {
                    if (state.state === 'failure') {
                        maybeSetRemainingMethods(state)
                        break
                    }

                    const prompts = state.prompts()

                    let responses: string[] = []
                    // OpenSSH can send a k-i request without prompts
                    // just respond ok to it
                    if (prompts.length > 0) {
                        // Pre-fill password prompts with the saved password.
                        const prefill: Array<string|null> = prompts.map(() => null)
                        if (method.savedPassword) {
                            for (let i = 0; i < prompts.length; i++) {
                                if (prompts[i].prompt.toLowerCase().includes('password') && !prompts[i].echo) {
                                    prefill[i] = method.savedPassword
                                }
                            }
                        }

                        try {
                            responses = await this.request('keyboard-interactive', {
                                name: state.name,
                                instruction: state.instructions,
                                prompts: prompts.map(p => ({ prompt: p.prompt, echo: p.echo })),
                                prefill,
                            })
                        } catch {
                            break // this loop
                        }
                    }

                    state = await (client as russh.SSHClient).continueKeyboardInteractiveAuthentication(responses)

                    if (state instanceof russh.AuthenticatedSSHClient) {
                        return state
                    }
                }
            }
            if (method.type === 'agent') {
                try {
                    const result = method.publicKey
                        ? await (client as russh.SSHClient).authenticateWithAgentIdentity(this.authUsername!, method, method.publicKey)
                        : await (client as russh.SSHClient).authenticateWithAgent(this.authUsername!, method)
                    if (result instanceof russh.AuthenticatedSSHClient) {
                        return result
                    }
                    maybeSetRemainingMethods(result)
                } catch (e) {
                    const identitySuffix = method.publicKey ? ` with identity ${method.publicKey.fingerprint()}` : ''
                    this.emitServiceMessage(`${MSG_WARN} Failed to authenticate using agent${identitySuffix}: ${e}`)
                    continue
                }
            }
        }
        return null
    }

    private async loadPrivateKey (_name: string, privateKeyContents: Buffer): Promise<russh.KeyPair> {
        return this.loadPrivateKeyWithPassphraseMaybe(privateKeyContents.toString())
    }

    // eslint-disable-next-line max-statements
    private async loadPrivateKeyWithPassphraseMaybe (privateKey: string): Promise<russh.KeyPair> {
        const keyHash = crypto.createHash('sha512').update(privateKey).digest('hex')

        privateKey = privateKey.replace(/EC PRIVATE KEY/g, 'PRIVATE KEY')

        let triedSavedPassphrase = false
        let passphrase: string|null = null
        while (true) {
            try {
                return await russh.KeyPair.parse(privateKey, passphrase ?? undefined)
            } catch (e) {
                if (!triedSavedPassphrase) {
                    passphrase = await this.request('load-key-passphrase', { keyHash })
                    triedSavedPassphrase = true
                    continue
                }
                if ([
                    'Error: Keys(KeyIsEncrypted)',
                    'Error: Keys(SshKey(Ppk(Encrypted)))',
                    'Error: Keys(SshKey(Ppk(IncorrectMac)))',
                    'Error: Keys(SshKey(Crypto))',
                ].includes(e.toString())) {
                    await this.request('delete-key-passphrase', { keyHash })

                    const result = await this.request('prompt', {
                        msgid: 'Private key passphrase',
                        password: true,
                        showRememberCheckbox: true,
                    } as PromptPayload)
                    if (!result) {
                        throw new Error('Passphrase prompt cancelled')
                    }

                    passphrase = result?.value
                    if (passphrase && result.remember) {
                        await this.request('save-key-passphrase', { keyHash, passphrase })
                    }
                } else {
                    await this.request('notify-error', {
                        msgid: 'Could not read the private key',
                        detail: e.toString(),
                    })
                    throw e
                }
            }
        }
    }

    // ── forwarded ports ───────────────────────────────────────────────────

    // eslint-disable-next-line max-statements
    async addPortForward (fw: ForwardedPort): Promise<void> {
        const client = this.client
        if (!(client instanceof russh.AuthenticatedSSHClient)) {
            throw new Error('Cannot add port forward before auth')
        }
        if (fw.type === 'Local' || fw.type === 'Dynamic') {
            await fw.startLocalListener(async (accept, reject, sourceAddress, sourcePort, targetAddress, targetPort) => {
                if (!(this.client instanceof russh.AuthenticatedSSHClient)) {
                    reject()
                    return
                }
                const channel = await this.client.activateChannel(await this.client.openTCPForwardChannel({
                    addressToConnectTo: targetAddress,
                    portToConnectTo: targetPort,
                    originatorAddress: sourceAddress ?? '127.0.0.1',
                    originatorPort: sourcePort ?? 0,
                }).catch(err => {
                    this.emitServiceMessage(`${MSG_X} Remote has rejected the forwarded connection to ${targetAddress}:${targetPort} via ${fw}: ${err}`)
                    reject()
                    throw err
                }))
                const socket = accept()

                this.setupSocketChannelEvents(channel, socket)
            }).then(() => {
                this.emitServiceMessage(`${MSG_FWD_OK_LOCAL} Forwarded ${fw}`)
                this.forwardedPorts.push(fw)
            }).catch(e => {
                this.emitServiceMessage(`${MSG_X} Failed to forward port ${fw}: ${e}`)
                throw e
            })
        }
        if (fw.type === 'Remote') {
            try {
                await client.forwardTCPPort(fw.host, fw.port)
            } catch (err) {
                this.emitServiceMessage(`${MSG_X} Remote rejected port forwarding for ${fw}: ${err}`)
                return
            }
            this.emitServiceMessage(`${MSG_FWD_OK_REMOTE} Forwarded ${fw}`)
            this.forwardedPorts.push(fw)
        }
    }

    async removePortForward (fw: ForwardedPort): Promise<void> {
        const client = this.client
        if (!(client instanceof russh.AuthenticatedSSHClient)) {
            throw new Error('Cannot remove port forward before auth')
        }
        if (fw.type === 'Local' || fw.type === 'Dynamic') {
            fw.stopLocalListener()
            this.forwardedPorts = this.forwardedPorts.filter(x => x !== fw)
        }
        if (fw.type === 'Remote') {
            client.stopForwardingTCPPort(fw.host, fw.port)
            this.forwardedPorts = this.forwardedPorts.filter(x => x !== fw)
        }
        this.emitServiceMessage(`Stopped forwarding ${fw}`)
    }

    listForwardedPorts (): ForwardedPortConfig[] {
        return this.forwardedPorts.map(fw => ({
            type: fw.type,
            host: fw.host,
            port: fw.port,
            targetAddress: fw.targetAddress,
            targetPort: fw.targetPort,
            description: fw.description,
        }))
    }

    // ── incoming channel pumps ────────────────────────────────────────────

    private setupChannelPumps (): void {
        const client = this.client
        if (!(client instanceof russh.AuthenticatedSSHClient)) {
            return
        }

        client.tcpChannelOpen$.subscribe(async event => {
            if (!(this.client instanceof russh.AuthenticatedSSHClient)) {
                return
            }

            const channel = await this.client.activateChannel(event.channel)

            const forward = this.forwardedPorts.find(x => x.port === event.targetPort && x.host === event.targetAddress)
            if (!forward) {
                this.emitServiceMessage(`${MSG_X} Rejected incoming forwarded connection for unrecognized port ${event.targetAddress}:${event.targetPort}`)
                channel.close()
                return
            }

            const socket = new net.Socket()
            socket.connect(forward.targetPort, forward.targetAddress)
            socket.on('error', e => {
                this.emitServiceMessage(`${MSG_X} Could not forward the remote connection to ${forward.targetAddress}:${forward.targetPort}: ${e}`)
                channel.close()
            })

            this.setupSocketChannelEvents(channel, socket)
        })

        client.x11ChannelOpen$.subscribe(async event => {
            const displaySpec = (this.config.x11Display || process.env.DISPLAY) ?? 'localhost:0'

            if (!(this.client instanceof russh.AuthenticatedSSHClient)) {
                return
            }

            const channel = await this.client.activateChannel(event.channel)

            const socket = new net.Socket()
            try {
                await new Promise<void>((resolve, reject) => {
                    socket.on('connect', () => resolve())
                    socket.on('error', e => reject(e))
                    socket.connect(resolveX11DisplaySpec(displaySpec))
                })
                this.setupSocketChannelEvents(channel, socket)
            } catch (e) {
                this.emitServiceMessage(`${MSG_X} Could not connect to the X server: ${e}`)
                this.emitServiceMessage(`    Trying display ${JSON.stringify(resolveX11DisplaySpec(displaySpec))} (DISPLAY: ${displaySpec})`)
                if (process.platform === 'win32') {
                    this.emitServiceMessage('    To use X forwarding, you need a local X server, e.g. VcXsrv or Xming')
                }
                channel.close()
            }
        })

        client.agentChannelOpen$.subscribe(async newChannel => {
            if (!(this.client instanceof russh.AuthenticatedSSHClient)) {
                return
            }

            const channel = await this.client.activateChannel(newChannel)

            const spec = await this.getAgentConnectionSpec()
            if (!spec) {
                await channel.close()
                return
            }

            const agent = await russh.SSHAgentStream.connect(spec)
            channel.data$.subscribe(data => agent.write(data))
            agent.data$.subscribe(data => channel.write(data).catch(() => undefined), undefined, () => channel.close())
            channel.closed$.subscribe(() => agent.close())
        })
    }

    private setupSocketChannelEvents (channel: russh.Channel, socket: net.Socket): void {
        channel.data$.subscribe({
            next: data => socket.write(data),
            error: err => {
                console.error('channel data error:', err)
                socket.destroy()
            },
        })

        socket.on('data', data => {
            try {
                channel.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
                    .catch(() => undefined)
            } catch (err) {
                console.error('channel write error:', err)
                socket.destroy()
            }
        })

        channel.eof$.subscribe(() => socket.end())

        channel.closed$.subscribe(() => socket.destroy())

        socket.on('error', () => channel.close())

        socket.on('close', () => channel.close())

        socket.on('end', () => channel.eof())
    }

    // ── shell channels ────────────────────────────────────────────────────

    async openShellChannel (options: { x11: boolean, command?: string|null }): Promise<string> {
        const client = this.client
        if (!(client instanceof russh.AuthenticatedSSHClient)) {
            throw new Error('Cannot open shell channel before auth')
        }
        const ch = await client.activateChannel(await client.openSessionChannel())
        await ch.requestPTY('xterm-256color', {
            columns: 80,
            rows: 24,
            pixHeight: 0,
            pixWidth: 0,
        })
        if (options.x11) {
            await ch.requestX11Forwarding({
                singleConnection: false,
                authProtocol: 'MIT-MAGIC-COOKIE-1',
                authCookie: crypto.randomBytes(16).toString('hex'),
                screenNumber: 0,
            })
        }
        if (this.options.agentForward) {
            await ch.requestAgentForwarding()
        }
        if (options.command) {
            await ch.requestExec(options.command)
        } else {
            await ch.requestShell()
        }

        const chId = uuidv4().toString()
        const entry: ChannelEntry = {
            id: chId,
            channel: ch,
            queue: new ChannelDataQueue(data => this.emit(`ch:${chId}:data`, data)),
        }
        this.channels.set(chId, entry)

        ch.data$.subscribe(data => entry.queue.push(data))
        ch.eof$.subscribe(() => this.emit(`ch:${chId}:eof`))
        ch.closed$.subscribe(() => {
            this.emit(`ch:${chId}:closed`)
            this.channels.delete(chId)
        })

        return chId
    }

    channelExists (chId: string): boolean {
        return this.channels.has(chId)
    }

    writeChannel (chId: string, data: Uint8Array): void {
        const entry = this.channels.get(chId)
        if (!entry) {
            return
        }
        try {
            entry.channel.write(data).catch(() => undefined)
        } catch { /* channel may have just closed */ }
    }

    resizeChannel (chId: string, columns: number, rows: number): void {
        const entry = this.channels.get(chId)
        if (!entry) {
            return
        }
        try {
            entry.channel.resizePTY({ columns, rows, pixHeight: 0, pixWidth: 0 })
        } catch { /* channel may have just closed */ }
    }

    ackChannelData (chId: string, length: number): void {
        this.channels.get(chId)?.queue.ack(length)
    }

    // ── SFTP ──────────────────────────────────────────────────────────────

    async openSFTP (): Promise<string> {
        const client = this.client
        if (!(client instanceof russh.AuthenticatedSSHClient)) {
            throw new Error('Cannot open SFTP session before auth')
        }
        if (!this.mainSftp) {
            this.mainSftp = await client.activateSFTP(await client.openSessionChannel())
        }
        const id = uuidv4().toString()
        const entry: SFTPEntry = { id, sftp: this.mainSftp, handles: new Map() }
        this.sftps.set(id, entry)
        this.mainSftp.closed$.subscribe(() => {
            this.emit('sftp-closed', id)
            this.sftps.delete(id)
        })
        return id
    }

    private getSftp (id: string): russh.SFTP {
        const entry = this.sftps.get(id)
        if (!entry) {
            throw new Error('SFTP session is closed')
        }
        return entry.sftp
    }

    async sftpOp (sftpId: string, op: string, args: any[]): Promise<any> {
        const sftp = this.getSftp(sftpId)
        switch (op) {
            case 'readdir': {
                const [p] = args
                const entries = await sftp.readDirectory(p)
                return entries.map(entry => ({
                    name: entry.name,
                    isDirectory: entry.metadata.type === russh.SFTPFileType.Directory,
                    isSymlink: entry.metadata.type === russh.SFTPFileType.Symlink,
                    mode: entry.metadata.permissions ?? 0,
                    size: entry.metadata.size,
                    mtime: entry.metadata.mtime ?? 0,
                }))
            }
            case 'readlink':
                return sftp.readlink(args[0])
            case 'stat': {
                const stats = await sftp.stat(args[0])
                return {
                    isDirectory: stats.type === russh.SFTPFileType.Directory,
                    isSymlink: stats.type === russh.SFTPFileType.Symlink,
                    mode: stats.permissions ?? 0,
                    size: stats.size,
                    mtime: stats.mtime ?? 0,
                }
            }
            case 'open': {
                const [p, mode] = args
                const handle = await sftp.open(p, mode)
                const handleId = uuidv4().toString()
                this.sftps.get(sftpId)!.handles.set(handleId, handle)
                return handleId
            }
            case 'rmdir':
                return sftp.removeDirectory(args[0])
            case 'mkdir':
                return sftp.createDirectory(args[0])
            case 'rename':
                return sftp.rename(args[0], args[1])
            case 'unlink':
                return sftp.removeFile(args[0])
            case 'chmod':
                return sftp.chmod(args[0], args[1])
            default:
                throw new Error(`Unknown SFTP op: ${op}`)
        }
    }

    async sftpHandleRead (sftpId: string, handleId: string): Promise<Buffer> {
        const handle = this.sftps.get(sftpId)?.handles.get(handleId)
        if (!handle) {
            throw new Error('File handle is closed')
        }
        return Buffer.from(await handle.read(256 * 1024))
    }

    async sftpHandleWrite (sftpId: string, handleId: string, chunk: Uint8Array): Promise<void> {
        const handle = this.sftps.get(sftpId)?.handles.get(handleId)
        if (!handle) {
            throw new Error('File handle is closed')
        }
        await handle.writeAll(chunk)
    }

    async sftpHandleClose (sftpId: string, handleId: string): Promise<void> {
        const handle = this.sftps.get(sftpId)?.handles.get(handleId)
        if (!handle) {
            return
        }
        this.sftps.get(sftpId)!.handles.delete(handleId)
        try {
            await handle.shutdown()
        } catch { /* already gone */ }
    }

    private mainSftp: russh.SFTP|null = null

    // ── teardown ──────────────────────────────────────────────────────────

    cancelGrace (): void {
        if (this.graceTimer) {
            clearTimeout(this.graceTimer)
            this.graceTimer = null
        }
    }

    /** Starts the abandoned-connection countdown (no-op if attachers remain). */
    armGrace (): void {
        if (this.graceTimer || this.closed || this.attachers.size || this.dependents.size) {
            return
        }
        this.graceTimer = setTimeout(() => {
            this.graceTimer = null
            if (!this.attachers.size && !this.dependents.size && !this.closed) {
                this.destroy()
            }
        }, GRACE_PERIOD_MS)
        this.graceTimer.unref?.()
    }

    destroy (): void {
        if (this.destroying || this.closed) {
            return
        }
        this.destroying = true
        this.closed = true
        this.cancelGrace()
        this.rejectPendingCallbacks('SSH connection closed')

        for (const fw of this.forwardedPorts) {
            fw.stopLocalListener()
        }
        for (const entry of this.channels.values()) {
            entry.queue.stop()
            try {
                entry.channel.close()
            } catch { /* already gone */ }
        }
        this.channels.clear()
        this.sftps.clear()
        if (this.client) {
            try {
                this.client.disconnect()
            } catch {
                // russh may throw SendError when closing an already-closed connection
            }
        }
        this.client = null

        if (this.jumpConnectionId) {
            const jump = this.manager.getConnection(this.jumpConnectionId)
            if (jump) {
                jump.dependents.delete(this.id)
                jump.armGrace()
            }
        }

        this.emit('destroyed')
        this.manager.dropConnection(this.id)
    }
}

export class SSHConnectionManager {
    private connections: Record<string, SSHConnection|undefined> = {}

    init (app: Application): void {
        ipcMain.on('ssh:spawn', (event, options: SSHConnectionOptions, config: SSHConfigSnapshot, jumpConnectionId: string|null) => {
            const id = uuidv4().toString()
            event.returnValue = id
            const conn = new SSHConnection(id, app, this, options, config, jumpConnectionId ?? null)
            conn.attachers.add(event.sender.id)
            conn.owner = event.sender.id
            this.connections[id] = conn
            void conn.connect()
        })

        ipcMain.on('ssh:attach', (event, id) => {
            const conn = this.connections[id]
            if (!conn || conn.closed) {
                event.returnValue = null
                return
            }
            conn.attachers.add(event.sender.id)
            conn.owner = event.sender.id
            conn.cancelGrace()
            event.returnValue = {
                open: conn.open,
                authUsername: conn.authUsername,
                usedPrivateKey: conn.activePrivateKey,
                forwardedPorts: conn.listForwardedPorts(),
            }
            conn.resendPendingCallbacks()
        })

        ipcMain.on('ssh:detach', (event, id) => {
            const conn = this.connections[id]
            if (!conn) {
                return
            }
            conn.attachers.delete(event.sender.id)
            if (conn.owner === event.sender.id) {
                conn.owner = [...conn.attachers].pop() ?? null
            }
            conn.armGrace()
        })

        ipcMain.on('ssh:kill', (_event, id) => {
            this.connections[id]?.destroy()
        })

        ipcMain.on('ssh:ch-write', (_event, connId, chId, data) => {
            this.connections[connId]?.writeChannel(chId, data)
        })

        ipcMain.on('ssh:ch-resize', (_event, connId, chId, columns, rows) => {
            this.connections[connId]?.resizeChannel(chId, columns, rows)
        })

        ipcMain.on('ssh:ch-ack', (_event, connId, chId, length) => {
            this.connections[connId]?.ackChannelData(chId, length)
        })

        ipcMain.on('ssh:cb-response', (_event, connId, cbId, payload) => {
            this.connections[connId]?.handleCallbackResponse(cbId, payload)
        })

        ipcMain.handle('ssh:open-shell', (_event, connId, options) => {
            return this.connections[connId]?.openShellChannel(options)
        })

        ipcMain.handle('ssh:forward-add', async (_event, connId, fw: ForwardedPortConfig) => {
            const conn = this.connections[connId]
            if (!conn) {
                return { ok: false, error: 'Connection is gone' }
            }
            try {
                await conn.addPortForward(new ForwardedPortHost(fw))
                return { ok: true }
            } catch (e) {
                return { ok: false, error: String(e) }
            }
        })

        ipcMain.handle('ssh:forward-remove', async (_event, connId, fw: ForwardedPortConfig) => {
            const conn = this.connections[connId]
            if (!conn) {
                return { ok: false, error: 'Connection is gone' }
            }
            try {
                await conn.removePortForward(new ForwardedPortHost(fw))
                return { ok: true }
            } catch (e) {
                return { ok: false, error: String(e) }
            }
        })

        ipcMain.handle('ssh:sftp-open', async (_event, connId) => {
            const conn = this.connections[connId]
            if (!conn) {
                throw new Error('Connection is gone')
            }
            return conn.openSFTP()
        })

        ipcMain.handle('ssh:sftp-op', (_event, connId, sftpId, op, args) => {
            const conn = this.connections[connId]
            if (!conn) {
                throw new Error('Connection is gone')
            }
            return conn.sftpOp(sftpId, op, args)
        })

        ipcMain.handle('ssh:sftp-handle-read', (_event, connId, sftpId, handleId) => {
            return this.connections[connId]?.sftpHandleRead(sftpId, handleId)
        })

        ipcMain.handle('ssh:sftp-handle-write', (_event, connId, sftpId, handleId, chunk) => {
            return this.connections[connId]?.sftpHandleWrite(sftpId, handleId, chunk)
        })

        ipcMain.handle('ssh:sftp-handle-close', (_event, connId, sftpId, handleId) => {
            return this.connections[connId]?.sftpHandleClose(sftpId, handleId)
        })

        ipcMain.handle('ssh:ch-attach', (_event, connId, chId) => {
            const conn = this.connections[connId]
            return !!conn && !conn.closed && conn.channelExists(chId)
        })
    }

    getConnection (id: string): SSHConnection|undefined {
        return this.connections[id]
    }

    dropConnection (id: string): void {
        delete this.connections[id]
    }

    /** Drops one window's claims; abandoned connections die after the grace period. */
    windowClosed (webContentsId: number): void {
        for (const conn of Object.values(this.connections)) {
            if (!conn) {
                continue
            }
            if (conn.attachers.delete(webContentsId)) {
                if (conn.owner === webContentsId) {
                    conn.owner = [...conn.attachers].pop() ?? null
                }
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

/** Adapter so the manager can rebuild a ForwardedPort from an IPC config. */
class ForwardedPortHost extends ForwardedPort {
    constructor (config: ForwardedPortConfig) {
        super()
        Object.assign(this, config)
    }
}
