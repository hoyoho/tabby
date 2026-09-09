import { Injectable } from '@angular/core'
import { ActionProvider, Action, ActionContext, ActionSurface, HostAppService, Platform } from 'tabby-core'
import { SSHTabComponent } from '../components/sshTab.component'

/** @hidden */
@Injectable()
export class PortForwardToolbarProvider extends ActionProvider {
    constructor (
        private hostApp: HostAppService,
    ) { super() }
    provide (ctx: ActionContext): Action[] {
        const tab = ctx.tab ?? null
        if (!tab || !(tab instanceof SSHTabComponent)) { return [] }
        if (this.hostApp.platform === Platform.Web) { return [] }
        return [{
            id: 'ssh:ports',
            label: 'Ports',
            icon: require('../icons/plug.svg'),
            weight: 6,
            surfaces: [ActionSurface.TerminalToolbar],
            run: () => tab.showPortForwarding(),
        }]
    }
}