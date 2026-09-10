import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import colors from 'ansi-colors'
import { Component, Injector, HostListener, Input } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ProfilesService, GetRecoveryTokenOptions, RecoveryToken } from 'tabby-core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent } from 'tabby-terminal'
import { SSHService } from '../services/ssh.service'
import { KeyboardInteractivePrompt, SSHSession } from '../session/ssh'
import { SSHPortForwardingModalComponent } from './sshPortForwardingModal.component'
import { SSHProfile } from '../api'
import { SSHShellSession } from '../session/shell'
import { SSHMultiplexerService } from '../services/sshMultiplexer.service'
import { SSHCallbackBridgeService } from '../services/sshCallbackBridge.service'

/** @hidden */
@Component({
    selector: 'ssh-tab',
    template: `${BaseTerminalTabComponent.template} ${require('./sshTab.component.pug')}`,
    styles: [
        ...BaseTerminalTabComponent.styles,
        require('./sshTab.component.scss'),
    ],
    animations: BaseTerminalTabComponent.animations,
})
export class SSHTabComponent extends ConnectableTerminalTabComponent<SSHProfile> {
    sshSession: SSHSession|null = null
    session: SSHShellSession|null = null
    sftpPanelVisible = false
    sftpPath = '/'
    activeKIPrompt: KeyboardInteractivePrompt|null = null
    /** Set when a FRESH connect failed — its auth UX was already shown, the
      * multiplex retry must not reconnect and prompt the user all over. */
    private noRetryOnFailure = false

    /** Set by the recovery provider when re-attaching a live connection. */
    @Input() restoreConnectionId?: string|null
    @Input() restoreChannelId?: string|null

    constructor (
        injector: Injector,
        public ssh: SSHService,
        private ngbModal: NgbModal,
        private profilesService: ProfilesService,
        private sshMultiplexer: SSHMultiplexerService,
        private sshCallbackBridge: SSHCallbackBridgeService,
    ) {
        super(injector)
        this.sessionChanged$.subscribe(() => {
            this.activeKIPrompt = null
        })
    }

    ngOnInit (): void {
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'home':
                    this.sendInput('\x1bOH' )
                    break
                case 'end':
                    this.sendInput('\x1bOF' )
                    break
                case 'restart-ssh-session':
                    this.reconnect()
                    break
                case 'launch-winscp':
                    if (this.sshSession) {
                        this.ssh.launchWinSCP(this.sshSession)
                    }
                    break
                case 'open-sftp':
                    this.openSFTP()
                    break
            }
        })

        super.ngOnInit()
    }

    // eslint-disable-next-line max-statements
    async setupOneSession (injector: Injector, profile: SSHProfile, multiplex = true, restoreConnectionId?: string|null): Promise<SSHSession> {
        let session: SSHSession|null = null
        let jumpSession: SSHSession|null = null

        if (restoreConnectionId) {
            // Prefer a live transferred connection over the multiplexer. If
            // this renderer already owns a facade for it (clone/recovery in the
            // same window), reuse that instance: sharing one refCount is what
            // keeps closing a single shell from killing the connection — and
            // with it every other shell still attached to it.
            session = this.sshCallbackBridge.findSession(restoreConnectionId)
            if (!session) {
                session = new SSHSession(injector, profile)
                if (!await session.attach(restoreConnectionId)) {
                    session = null
                }
            }
        }

        if (!session) {
            session = await this.sshMultiplexer.getSession(profile)
        }

        if (!multiplex || !session || !profile.options.reuseSession) {
            session = new SSHSession(injector, profile)

            if (profile.options.jumpHost) {
                const jumpConnection = (await this.profilesService.getProfiles()).find(x => x.id === profile.options.jumpHost)

                if (!jumpConnection) {
                    throw new Error(`${profile.options.host}: jump host "${profile.options.jumpHost}" not found in your config`)
                }

                jumpSession = await this.setupOneSession(
                    this.injector,
                    this.profilesService.getConfigProxyForProfile<SSHProfile>(jumpConnection),
                )

                jumpSession.ref()
                session.willDestroy$.subscribe(() => jumpSession!.unref())
                jumpSession.willDestroy$.subscribe(() => {
                    if (session?.open) {
                        session.destroy()
                    }
                })
            }
        }

        session = session!

        this.attachSessionHandler(session.serviceMessage$, msg => {
            msg = msg.replace(/\n/g, '\r\n      ')
            this.write(`\r${colors.black.bgWhite(' SSH ')} ${msg}\r\n`)
        })

        this.attachSessionHandler(session.willDestroy$, () => {
            this.activeKIPrompt = null
        })

        this.attachSessionHandler(session.keyboardInteractivePrompt$, prompt => {
            this.activeKIPrompt = prompt
            setTimeout(() => {
                this.frontend?.scrollToBottom()
            })
        })

        if (!session.open) {
            this.write('\r\n' + colors.black.bgWhite(' SSH ') + ` Connecting to ${session.profile.name}\r\n`)

            this.startSpinner(this.translate.instant(_('Connecting')))

            try {
                await session.start({ jumpConnectionId: jumpSession?.getID() ?? null })
            } catch (e) {
                // The user just went through the whole connect/auth UX on this
                // fresh connection (prompts, cancels, failures) — mark it so
                // the outer multiplex retry does not run it all again.
                this.noRetryOnFailure = true
                throw e
            } finally {
                this.stopSpinner()
            }

            this.sshMultiplexer.addSession(session)
        }

        return session
    }

    protected onSessionDestroyed (): void {
        if (this.frontend) {
            // Session was closed abruptly
            this.write('\r\n' + colors.black.bgWhite(' SSH ') + ` ${this.sshSession?.profile.options.host}: session closed\r\n`)

            super.onSessionDestroyed()
        }
    }

    private async initializeSessionMaybeMultiplex (multiplex = true): Promise<void> {
        this.sshSession = await this.setupOneSession(this.injector, this.profile, multiplex, this.restoreConnectionId)
        const session = new SSHShellSession(this.injector, this.sshSession, this.profile)

        this.setSession(session)
        this.attachSessionHandler(session.serviceMessage$, msg => {
            msg = msg.replace(/\n/g, '\r\n      ')
            this.write(`\r${colors.black.bgWhite(' SSH ')} ${msg}\r\n`)
            session.resize(this.size.columns, this.size.rows)
        })

        await session.start({ restoreFromChannelId: this.restoreChannelId ?? null })
        this.restoreConnectionId = null
        this.restoreChannelId = null

        this.session?.resize(this.size.columns, this.size.rows)
    }

    async initializeSession (): Promise<void> {
        await super.initializeSession()
        this.noRetryOnFailure = false
        try {
            await this.initializeSessionMaybeMultiplex(true)
        } catch (e) {
            this.restoreConnectionId = null
            this.restoreChannelId = null
            if (this.noRetryOnFailure) {
                // A fresh connection already failed with full auth UX —
                // retrying would just reconnect and prompt all over again.
                console.error('SSH session initialization failed', e)
                this.write(colors.black.bgRed(' X ') + ' ' + colors.red(e.message) + '\r\n')
                return
            }
            try {
                await this.initializeSessionMaybeMultiplex(false)
            } catch (e) {
                console.error('SSH session initialization failed', e)
                this.write(colors.black.bgRed(' X ') + ' ' + colors.red(e.message) + '\r\n')
                return
            }
        }
    }

    async getRecoveryToken (options?: GetRecoveryTokenOptions): Promise<RecoveryToken> {
        return {
            ...(await super.getRecoveryToken(options)),
            // The live connection id travels with EVERY token (not just state
            // transfers): a duplicate/clone then attaches to the already-
            // authenticated connection even after the profile's auth mode was
            // switched — no re-prompt while the old connection lives. When it
            // is gone, attach fails and the new mode authenticates fresh.
            sshConnectionId: this.sshSession?.getID() ?? null,
            shellChannelId: options?.includeState && this.session?.getID() || null,
        }
    }

    showPortForwarding (): void {
        const modal = this.ngbModal.open(SSHPortForwardingModalComponent).componentInstance as SSHPortForwardingModalComponent
        modal.session = this.sshSession!
    }

    async canClose (): Promise<boolean> {
        if (!this.session?.open) {
            return true
        }
        if (!(this.profile.options.warnOnClose ?? this.config.store.ssh.warnOnClose)) {
            return true
        }
        return (await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant(_('Disconnect from {host}?'), this.profile.options),
                buttons: [
                    this.translate.instant(_('Disconnect')),
                    this.translate.instant(_('Do not close')),
                ],
                defaultId: 0,
                cancelId: 1,
            },
        )).response === 0
    }

    async openSFTP (): Promise<void> {
        this.sftpPath = await this.session?.getWorkingDirectory() ?? this.sftpPath
        setTimeout(() => {
            this.sftpPanelVisible = true
        }, 100)
    }

    @HostListener('click')
    onClick (): void {
        this.sftpPanelVisible = false
    }

    protected isSessionExplicitlyTerminated (): boolean {
        // A session end is signalled by a protocol-level EOF/close (shell.eof$),
        // so a stuck remote process can never reach this point. Once the session
        // has really ended, treat it as explicitly terminated so the tab closes
        // by itself — same as WSL. 'keep' / 'reconnect' end-of-session behaviours
        // are still honoured in ConnectableTerminalTabComponent.
        return true
    }
}
