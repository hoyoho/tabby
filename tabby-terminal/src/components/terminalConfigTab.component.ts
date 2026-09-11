import { Component, HostBinding } from '@angular/core'
import { ConfigService, HostAppService, Platform, altKeyName, metaKeyName } from 'tabby-core'

/** @hidden */
@Component({
    selector: 'terminal-config-tab',
    templateUrl: './terminalConfigTab.component.pug',
})
export class TerminalConfigTabComponent {
    Platform = Platform
    altKeyName = altKeyName
    metaKeyName = metaKeyName

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
    ) { }
}