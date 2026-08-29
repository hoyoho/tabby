import { Injectable } from '@angular/core'
import { ToolbarButtonProvider, ToolbarButton, AppService, HostAppService, HotkeysService } from 'tabby-core'

import { SettingsTabComponent } from './components/settingsTab.component'

/** @hidden */
@Injectable()
export class ButtonProvider extends ToolbarButtonProvider {
    constructor (
        hostApp: HostAppService,
        hotkeys: HotkeysService,
        private app: AppService,
    ) {
        super()
        hostApp.settingsUIRequest$.subscribe(() => this.open())

        hotkeys.hotkey$.subscribe(async (hotkey) => {
            if (hotkey === 'settings') {
                this.open()
            }
        })
    }

    provide (): ToolbarButton[] {
        // The settings gear lived in the workspace toolbar; settings are now
        // reachable from the title-bar hamburger menu instead.
        return []
    }

    open (): void {
        const settingsTab = this.app.tabs.find(tab => tab instanceof SettingsTabComponent)
        if (settingsTab) {
            this.app.selectTab(settingsTab)
        } else {
            this.app.openNewTabRaw({ type: SettingsTabComponent })
        }
    }
}
