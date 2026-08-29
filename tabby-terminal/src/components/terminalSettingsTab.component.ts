import { Component, HostBinding } from '@angular/core'
import { ConfigService, HostAppService, Platform, altKeyName, metaKeyName } from 'tabby-core'

/** @hidden */
@Component({
    templateUrl: './terminalSettingsTab.component.pug',
})
export class TerminalSettingsTabComponent {
    Platform = Platform
    altKeyName = altKeyName
    metaKeyName = metaKeyName

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
    ) { }
}
