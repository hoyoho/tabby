import { Component, HostBinding, Injectable, inject } from '@angular/core'
import { WIN_BUILD_CONPTY_SUPPORTED, WIN_BUILD_BUNDLED_CONPTY_SUPPORTED, isWindowsBuild, ConfigService, HostAppService, Platform } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

/** @hidden */
@Component({
    templateUrl: './shellSettingsTab.component.pug',
})
export class ShellSettingsTabComponent {
    isConPTYAvailable: boolean
    isBundledConPTYAvailable: boolean

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
    ) {
        this.isConPTYAvailable = isWindowsBuild(WIN_BUILD_CONPTY_SUPPORTED)
        this.isBundledConPTYAvailable = isWindowsBuild(WIN_BUILD_BUNDLED_CONPTY_SUPPORTED)
    }
}

/** @hidden */
@Injectable()
export class ShellSettingsTabProvider extends SettingsTabProvider {
    id = 'terminal-shell'
    icon = 'list-ul'
    /** Translation key, rendered through the translate pipe/directive */
    title = 'Local'
    section = 'profiles-advanced'
    weight = 20
    private hostApp = inject(HostAppService)

    getComponentType (): any {
        if (this.hostApp.platform === Platform.Windows) {
            return ShellSettingsTabComponent
        }
    }
}
