import shellQuote from 'shell-quote'
import { Injectable } from '@angular/core'
import { CLIHandler, CLIEvent, HostWindowService, TranslateService, PlatformService, SessionService } from 'tabby-core'
import { BaseTerminalTabComponent } from './api/baseTerminalTab.component'

@Injectable()
export class TerminalCLIHandler extends CLIHandler {
    firstMatchOnly = true
    priority = 0

    constructor (
        private session: SessionService,
        private hostWindow: HostWindowService,
        private platform: PlatformService,
        private translate: TranslateService,
    ) {
        super()
    }

    async handle (event: CLIEvent): Promise<boolean> {
        const op = event.argv._[0]

        if (op === 'paste') {
            let text = event.argv.text!
            if (event.argv.escape!) {
                text = shellQuote.quote([text])
            }

            if ((await this.platform.showMessageBox({
                type: 'warning',
                message: this.translate.instant(`Paste "{text}"?`, { text }),
                buttons: [
                    this.translate.instant('Paste'),
                    this.translate.instant('Cancel'),
                ],
                defaultId: 0,
                cancelId: 1,
            })).response === 1) {
                return true
            }

            this.handlePaste(text)
            return true
        }

        return false
    }

    private handlePaste (text: string) {
        const tab = this.session.getFocused()
        if (tab instanceof BaseTerminalTabComponent && tab.session) {
            tab.sendInput(text)
            this.hostWindow.bringToFront()
        }
    }
}
