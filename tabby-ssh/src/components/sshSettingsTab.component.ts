import { Component, HostBinding, Injectable } from '@angular/core'
import { X11Socket } from '../session/x11'
import { ConfigService, HostAppService, Platform } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

/** @hidden */
@Component({
    templateUrl: './sshSettingsTab.component.pug',
})
export class SSHSettingsTabComponent {
    Platform = Platform
    defaultX11Display: string

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
    ) {
        const spec = X11Socket.resolveDisplaySpec()
        if ('path' in spec) {
            this.defaultX11Display = spec.path
        } else {
            this.defaultX11Display = `${spec.host}:${spec.port}`
        }
    }
}

/** @hidden */
@Injectable()
export class SSHSettingsTabProvider extends SettingsTabProvider {
    id = 'ssh'
    icon = 'globe'
    title = 'SSH'
    section = 'profiles-advanced'
    weight = 10

    getComponentType (): any {
        return SSHSettingsTabComponent
    }
}
