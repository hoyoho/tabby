import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import colors from 'ansi-colors'
import { Component, Injector, Input } from '@angular/core'
import { Platform, GetRecoveryTokenOptions } from 'tabby-core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent } from 'tabby-terminal'
import { TelnetProfile, TelnetSession } from '../session'


/** @hidden */
@Component({
    selector: 'telnet-tab',
    template: `${BaseTerminalTabComponent.template} ${require('./telnetTab.component.pug')}`,
    styleUrls: ['./telnetTab.component.scss', ...BaseTerminalTabComponent.styles],
    animations: BaseTerminalTabComponent.animations,
})
export class TelnetTabComponent extends ConnectableTerminalTabComponent<TelnetProfile> {
    Platform = Platform
    session: TelnetSession|null = null

    /** Set by the recovery provider when re-attaching a live telnet connection. */
    @Input() restoreSocketId?: string|null

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        injector: Injector,
    ) {
        super(injector)
    }

    ngOnInit (): void {
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (this.hasFocus && hotkey === 'restart-telnet-session') {
                this.reconnect()
            }
        })

        super.ngOnInit()
    }

    protected onSessionDestroyed (): void {
        if (this.frontend) {
            // Session was closed abruptly
            this.write('\r\n' + colors.black.bgWhite(' TELNET ') + ` ${this.session?.profile.options.host}: session closed\r\n`)

            super.onSessionDestroyed()
        }
    }

    async initializeSession (): Promise<void> {
        await super.initializeSession()

        const session = new TelnetSession(this.injector, this.profile)
        this.setSession(session)

        try {
            this.startSpinner(this.translate.instant(_('Connecting')))

            this.attachSessionHandler(session.serviceMessage$, msg => {
                this.write(`\r${colors.black.bgWhite(' Telnet ')} ${msg}\r\n`)
                session.resize(this.size.columns, this.size.rows)
            })

            try {
                await session.start(this.restoreSocketId ? { restoreFromSocketID: this.restoreSocketId } : undefined)
                this.restoreSocketId = null
                this.stopSpinner()
            } catch (e) {
                this.stopSpinner()
                this.write(colors.black.bgRed(' X ') + ' ' + colors.red(e.message) + '\r\n')
                return
            }
        } catch (e) {
            this.write(colors.black.bgRed(' X ') + ' ' + colors.red(e.message) + '\r\n')
        }
    }

    override async getRecoveryToken (options?: GetRecoveryTokenOptions): Promise<any> {
        return {
            ...await super.getRecoveryToken(options),
            socketId: options?.includeState && this.session?.getID() || null,
        }
    }

    async canClose (): Promise<boolean> {
        if (!this.session?.open) {
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

    protected isSessionExplicitlyTerminated (): boolean {
        return super.isSessionExplicitlyTerminated() ||
        this.recentInputs.endsWith('close\r') ||
        this.recentInputs.endsWith('quit\r')
    }

}
