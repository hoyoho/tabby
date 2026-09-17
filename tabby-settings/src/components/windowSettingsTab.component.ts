/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { debounce } from 'utils-decorators/dist/esm/debounce/debounce'
import { Component, HostBinding, Optional } from '@angular/core'
import {
    DockingService,
    ConfigService,
    HostAppService,
    Platform,
    BaseComponent,
    PlatformService,
} from 'tabby-core'


/** @hidden */
@Component({
    selector: 'window-settings-tab',
    templateUrl: './windowSettingsTab.component.pug',
})
export class WindowSettingsTabComponent extends BaseComponent {
    Platform = Platform

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
        public platform: PlatformService,
        @Optional() public docking?: DockingService,
    ) {
        super()
    }

    @debounce(500)
    saveConfiguration (requireRestart?: boolean) {
        this.config.save()
        if (requireRestart) {
            this.config.requestRestart()
        }
    }
}
