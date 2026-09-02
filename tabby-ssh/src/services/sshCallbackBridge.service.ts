import { Injectable, Injector } from '@angular/core'
import { ipcRenderer } from 'electron'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, FileProvidersService, NotificationsService, PromptModalComponent, TranslateService } from 'tabby-core'
import { AutoPrivateKeyLocator } from '../api'
import { KeyboardInteractivePrompt, SSHSession } from '../session/ssh'
import { HostKeyPromptModalComponent } from '../components/hostKeyPromptModal.component'
import { PasswordStorageService } from './passwordStorage.service'
import { SSHKnownHostsService } from './sshKnownHosts.service'

/**
 * Answers UI-dependent requests from main-process SSH connections
 * (`app/lib/ssh.ts`): modals, password storage, known hosts and private key
 * file loading. Secrets never leave this renderer; the main process only
 * receives what the SSH layer itself needs (key contents for auth).
 */
@Injectable({ providedIn: 'root' })
export class SSHCallbackBridgeService {
    private sessions = new Map<string, SSHSession>()
    private injector: Injector
    private ngbModal: NgbModal
    private translate: TranslateService
    private config: ConfigService
    private passwordStorage: PasswordStorageService
    private knownHosts: SSHKnownHostsService
    private fileProviders: FileProvidersService
    private notifications: NotificationsService

    constructor (injector: Injector) {
        this.injector = injector
        // Lazy service resolution: this service may be instantiated during
        // Angular bootstrap where eager injection could hit NullInjector.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!ipcRenderer.listenerCount('ssh:cb')) {
            ipcRenderer.on('ssh:cb', (_event, connId, cbId, method, ...args) => {
                void this.handle(connId, cbId, method, args)
            })
        }
    }

    registerSession (connId: string, session: SSHSession): void {
        this.sessions.set(connId, session)
    }

    unregisterSession (connId: string): void {
        this.sessions.delete(connId)
    }

    private async respond (connId: string, cbId: string, result: any): Promise<void> {
        ipcRenderer.send('ssh:cb-response', connId, cbId, { ok: true, result })
    }

    private async respondError (connId: string, cbId: string, error: any): Promise<void> {
        ipcRenderer.send('ssh:cb-response', connId, cbId, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }

    private async handle (connId: string, cbId: string, method: string, args: any[]): Promise<void> {
        try {
            let result: any = null
            switch (method) {
                case 'prompt':
                    result = await this.handlePrompt(args[0])
                    break
                case 'keyboard-interactive':
                    result = await this.handleKeyboardInteractive(connId, args[0])
                    break
                case 'host-key':
                    result = await this.handleHostKey(args[0])
                    break
                case 'load-password':
                    result = await this.getPasswordStorage().loadPassword(this.getSession(connId).profile, args[0].username)
                    break
                case 'save-password':
                    await this.getPasswordStorage().savePassword(this.getSession(connId).profile, args[0].password, args[0].username)
                    break
                case 'delete-password':
                    await this.getPasswordStorage().deletePassword(this.getSession(connId).profile, args[0].username)
                    break
                case 'load-key-passphrase':
                    result = await this.getPasswordStorage().loadPrivateKeyPassword(args[0].keyHash)
                    break
                case 'save-key-passphrase':
                    await this.getPasswordStorage().savePrivateKeyPassword(args[0].keyHash, args[0].passphrase)
                    break
                case 'delete-key-passphrase':
                    await this.getPasswordStorage().deletePrivateKeyPassword(args[0].keyHash)
                    break
                case 'retrieve-file': {
                    try {
                        const contents = await this.getFileProviders().retrieveFile(args[0].path)
                        result = contents ? Array.from(contents) : null
                    } catch {
                        result = null
                    }
                    break
                }
                case 'locate-private-keys': {
                    result = []
                    for (const importer of this.injector.get(AutoPrivateKeyLocator, [])) {
                        for (const [name, contents] of await importer.getKeys()) {
                            result.push({ name, contents: Array.from(contents) })
                        }
                    }
                    break
                }
                case 'notify-error':
                    this.getNotifications().error(this.getTranslate().instant(args[0].msgid), args[0].detail)
                    break
                default:
                    throw new Error(`Unknown SSH callback: ${method}`)
            }
            await this.respond(connId, cbId, result)
        } catch (e) {
            await this.respondError(connId, cbId, e)
        }
    }

    private getSession (connId: string): SSHSession {
        const session = this.sessions.get(connId)
        if (!session) {
            throw new Error('No tab is attached to this SSH connection')
        }
        return session
    }

    private async handlePrompt (payload: {
        msgid: string
        params?: Record<string, unknown>
        password: boolean
        showRememberCheckbox?: boolean
        value?: string|null
    }): Promise<{ value: string, remember?: boolean }|null> {
        const modal = this.getNgbModal().open(PromptModalComponent)
        modal.componentInstance.prompt = this.getTranslate().instant(payload.msgid, payload.params)
        modal.componentInstance.password = payload.password
        modal.componentInstance.showRememberCheckbox = payload.showRememberCheckbox ?? false
        if (payload.value) {
            modal.componentInstance.value = payload.value
        }
        return modal.result.catch(() => null)
    }

    private async handleKeyboardInteractive (connId: string, payload: {
        name: string
        instruction: string
        prompts: Array<{ prompt: string, echo?: boolean }>
        prefill: Array<string|null>
    }): Promise<string[]> {
        const session = this.getSession(connId)
        const prompt = new KeyboardInteractivePrompt(
            payload.name,
            payload.instruction,
            payload.prompts,
        )
        payload.prefill?.forEach((value, index) => {
            if (value !== null) {
                prompt.responses[index] = value
            }
        })
        session.emitKeyboardInteractivePrompt(prompt)
        return await prompt.promise
    }

    private async handleHostKey (payload: {
        selector: { host: string, port: number, type: string }
        digest: string
    }): Promise<boolean> {
        if (!this.getConfig().store.ssh.verifyHostKeys) {
            return true
        }
        const knownHost = this.getKnownHosts().getFor(payload.selector)
        if (knownHost && knownHost.digest === payload.digest) {
            return true
        }
        const modal = this.getNgbModal().open(HostKeyPromptModalComponent)
        modal.componentInstance.selector = payload.selector
        modal.componentInstance.digest = payload.digest
        return modal.result.catch(() => false)
    }

    // Lazy getters keep construction order safe during bootstrap.
    private getNgbModal (): NgbModal { return this.ngbModal ??= this.injector.get(NgbModal) }
    private getTranslate (): TranslateService { return this.translate ??= this.injector.get(TranslateService) }
    private getConfig (): ConfigService { return this.config ??= this.injector.get(ConfigService) }
    private getPasswordStorage (): PasswordStorageService { return this.passwordStorage ??= this.injector.get(PasswordStorageService) }
    private getKnownHosts (): SSHKnownHostsService { return this.knownHosts ??= this.injector.get(SSHKnownHostsService) }
    private getFileProviders (): FileProvidersService { return this.fileProviders ??= this.injector.get(FileProvidersService) }
    private getNotifications (): NotificationsService { return this.notifications ??= this.injector.get(NotificationsService) }
}
