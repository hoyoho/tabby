import { Injectable } from '@angular/core'
import { ActionProvider, Action, ActionContext, ActionSurface } from 'tabby-core'
import { SSHTabComponent } from '../components/sshTab.component'

/** @hidden */
@Injectable()
export class SFTPToolbarProvider extends ActionProvider {
    provide (ctx: ActionContext): Action[] {
        const tab = ctx.tab ?? null
        if (!tab || !(tab instanceof SSHTabComponent)) { return [] }
        return [{
            id: 'ssh:sftp',
            label: 'SFTP',
            title: 'SFTP',
            icon: require('../icons/sftp.svg'),
            weight: 5,
            surfaces: [ActionSurface.TerminalToolbar],
            run: () => tab.openSFTP(),
        }]
    }
}
