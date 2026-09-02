import { IpcRendererEvent, ipcRenderer } from 'electron'
import { Observable, Subject } from 'rxjs'
import stripAnsi from 'strip-ansi'
import { Injector } from '@angular/core'
import { LogService } from 'tabby-core'
import { BaseSession, UTF8SplitterMiddleware, InputProcessor } from 'tabby-terminal'
import { SSHSession } from './ssh'
import { SSHProfile } from '../api'

/**
 * Renderer-side stand-in for one shell channel of a main-process SSH
 * connection. Data flows over `ssh:<connId>:ch:<chId>:*` events with the
 * same chunk+ack flow control as local PTYs.
 */
export class SSHShellChannelProxy {
    readonly data$ = new Subject<Buffer>()
    readonly eof$ = new Subject<void>()
    readonly closed$ = new Subject<void>()

    private wired = false

    constructor (
        private connId: string,
        public id: string,
    ) { }

    wire (): void {
        if (this.wired) {
            return
        }
        this.wired = true
        ipcRenderer.on(`ssh:${this.connId}:ch:${this.id}:data`, this.dataListener)
        ipcRenderer.on(`ssh:${this.connId}:ch:${this.id}:eof`, this.eofListener)
        ipcRenderer.on(`ssh:${this.connId}:ch:${this.id}:closed`, this.closedListener)
    }

    unwire (): void {
        if (!this.wired) {
            return
        }
        this.wired = false
        ipcRenderer.off(`ssh:${this.connId}:ch:${this.id}:data`, this.dataListener)
        ipcRenderer.off(`ssh:${this.connId}:ch:${this.id}:eof`, this.eofListener)
        ipcRenderer.off(`ssh:${this.connId}:ch:${this.id}:closed`, this.closedListener)
        this.data$.complete()
        this.eof$.complete()
        this.closed$.complete()
    }

    write (data: Buffer): void {
        ipcRenderer.send('ssh:ch-write', this.connId, this.id, data)
    }

    resizePTY (dimensions: { columns: number, rows: number }): void {
        ipcRenderer.send('ssh:ch-resize', this.connId, this.id, dimensions.columns, dimensions.rows)
    }

    ackData (length: number): void {
        ipcRenderer.send('ssh:ch-ack', this.connId, this.id, length)
    }

    private dataListener = (_e: IpcRendererEvent, data: Buffer) => this.data$.next(Buffer.from(data))
    private eofListener = () => this.eof$.next()
    private closedListener = () => this.closed$.next()
}

export class SSHShellSession extends BaseSession {
    shell?: SSHShellChannelProxy
    get serviceMessage$ (): Observable<string> { return this.serviceMessage }
    private serviceMessage = new Subject<string>()
    private ssh: SSHSession|null
    private destroying = false

    /**
     * When set, destroy() tears down this session's listeners/state but keeps
     * the underlying main-process connection and shell channel alive for the
     * target window of a cross-window drag.
     */
    keepPTYAlive = false

    constructor (
        injector: Injector,
        ssh: SSHSession,
        private profile: SSHProfile,
    ) {
        super(injector.get(LogService).create(`ssh-shell-${profile.options.host}-${profile.options.port}`))
        this.ssh = ssh
        this.setLoginScriptsOptions(this.profile.options)
        this.ssh.serviceMessage$.subscribe(m => this.serviceMessage.next(m))
        this.middleware.push(new UTF8SplitterMiddleware())
        this.middleware.push(new InputProcessor(profile.options.input))
    }

    async start (options?: { restoreFromChannelId?: string|null }): Promise<void> {
        if (!this.ssh) {
            throw new Error('SSH session not set')
        }
        const ssh = this.ssh
        const connId = ssh.getID()
        if (!connId) {
            throw new Error('SSH connection is gone')
        }

        ssh.ref()
        ssh.willDestroy$.subscribe(() => {
            this.destroy()
        })

        let chId: string|null = null
        if (options?.restoreFromChannelId) {
            const ok: boolean = await ipcRenderer.invoke('ssh:ch-attach', connId, options.restoreFromChannelId)
            if (ok) {
                chId = options.restoreFromChannelId
            }
        }

        if (!chId) {
            this.logger.debug('Opening shell')
            try {
                chId = await ssh.openShellChannel({ x11: this.profile.options.x11 })
            } catch (err) {
                if (err.toString().includes('Unable to request X11')) {
                    this.emitServiceMessage('    Make sure `xauth` is installed on the remote side')
                }
                throw new Error(`Remote rejected opening a shell channel: ${err}`)
            }
        }

        const shell = this.shell = new SSHShellChannelProxy(connId, chId)
        shell.wire()

        this.open = true
        this.logger.debug('Shell open')

        if (!options?.restoreFromChannelId) {
            this.loginScriptProcessor?.executeUnconditionalScripts()
        }

        shell.data$.subscribe(data => {
            shell.ackData(data.length)
            this.emitOutput(data)
        })

        shell.eof$.subscribe(() => {
            this.logger.info('Shell session ended')
            if (this.open) {
                this.destroy()
            }
        })

        // Some servers shut the connection down without a clean EOF; the tab
        // must still close instead of staying as a seemingly-live session.
        shell.closed$.subscribe(() => {
            this.logger.info('Shell channel closed')
            if (this.open) {
                this.destroy()
            }
        })
    }

    emitServiceMessage (msg: string): void {
        this.serviceMessage.next(msg)
        this.logger.info(stripAnsi(msg))
    }

    getID (): string|null {
        return this.shell?.id ?? null
    }

    resize (columns: number, rows: number): void {
        this.shell?.resizePTY({
            columns,
            rows,
        })
    }

    write (data: Buffer): void {
        this.shell?.write(data)
    }

    kill (_signal?: string): void {
        // this.shell?.signal(signal ?? 'TERM')
    }

    override async destroy (): Promise<void> {
        if (this.destroying) {
            return
        }
        this.destroying = true
        this.logger.debug('Closing shell')
        this.serviceMessage.complete()
        if (this.keepPTYAlive) {
            // The tab is transferring to another window: release renderer
            // state only, the main-process connection/channels stay alive.
            this.open = false
            this.middleware.close()
            this.closed.next()
            this.destroyed.next()
            this.closed.complete()
            this.destroyed.complete()
            this.output.complete()
            this.binaryOutput.complete()
            this.shell?.unwire()
            this.shell = undefined
            this.ssh?.releaseForTransfer()
            this.ssh = null
            return
        }
        this.kill()
        this.ssh?.unref()
        this.ssh = null
        await super.destroy()
        this.shell?.unwire()
        this.shell = undefined
    }

    async getChildProcesses (): Promise<any[]> {
        return []
    }

    async gracefullyKillProcess (): Promise<void> {
        this.kill('TERM')
    }

    supportsWorkingDirectory (): boolean {
        return !!this.reportedCWD
    }

    async getWorkingDirectory (): Promise<string|null> {
        return this.reportedCWD ?? null
    }
}
