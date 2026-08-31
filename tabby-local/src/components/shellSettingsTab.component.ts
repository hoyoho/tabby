import { Component, HostBinding, Injectable, inject } from '@angular/core'
import { WIN_BUILD_CONPTY_SUPPORTED, WIN_BUILD_CONPTY_STABLE, isWindowsBuild, ConfigService, HostAppService, Platform } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

/** @hidden */
@Component({
    templateUrl: './shellSettingsTab.component.pug',
})
export class ShellSettingsTabComponent {
    isConPTYAvailable: boolean
    isConPTYStable: boolean

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
    ) {
        this.isConPTYAvailable = isWindowsBuild(WIN_BUILD_CONPTY_SUPPORTED)
        this.isConPTYStable = isWindowsBuild(WIN_BUILD_CONPTY_STABLE)
    }
}

/** @hidden */
@Injectable()
export class ShellSettingsTabProvider extends SettingsTabProvider {
    id = 'terminal-shell'
    icon = 'list-ul'
    /** Translation key, rendered through the translate pipe/directive */
    title = 'Shell'
    section = 'profiles-advanced'
    weight = 20
    private hostApp = inject(HostAppService)

    getComponentType (): any {
        if (this.hostApp.platform === Platform.Windows) {
            return ShellSettingsTabComponent
        }
    }
}
