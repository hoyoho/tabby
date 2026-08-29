import { Injectable } from '@angular/core'
import { TranslateService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { PluginsSettingsTabComponent } from './components/pluginsSettingsTab.component'

/** @hidden */
@Injectable()
export class PluginsSettingsTabProvider extends SettingsTabProvider {
    id = 'plugins'
    title: string

    constructor (translate: TranslateService) {
        super()
        this.title = translate.instant('Plugins')
    }

    getComponentType (): any {
        return PluginsSettingsTabComponent
    }
}
