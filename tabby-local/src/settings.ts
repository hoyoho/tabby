import { Injectable } from '@angular/core'
import { HostAppService, Platform, TranslateService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { ShellSettingsTabComponent } from './components/shellSettingsTab.component'

/** @hidden */
@Injectable()
export class ShellSettingsTabProvider extends SettingsTabProvider {
    id = 'terminal-shell'
    icon = 'list-ul'
    title: string

    constructor (private hostApp: HostAppService, translate: TranslateService) {
        super()
        this.title = translate.instant('Shell')
    }

    getComponentType (): any {
        if (this.hostApp.platform === Platform.Windows) {
            return ShellSettingsTabComponent
        }
    }
}
