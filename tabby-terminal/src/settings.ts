import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { TerminalTabComponent } from './components/terminalTab.component'
import { TranslateService } from 'tabby-core'

/** @hidden */
@Injectable()
export class TerminalSettingsTabProvider extends SettingsTabProvider {
    id = 'terminal'
    icon = 'terminal'
    title = this.translate.instant('Terminal')
    prioritized = true

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return TerminalTabComponent
    }
}
