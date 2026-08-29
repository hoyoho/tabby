import { Component, Input } from '@angular/core'
import { HostWindowService, HostAppService, Platform } from '../api'
import { ConfigService } from '../services/config.service'

/** @hidden */
@Component({
    selector: 'title-bar',
    templateUrl: './titleBar.component.pug',
    styleUrls: ['./titleBar.component.scss'],
})
export class TitleBarComponent {
    Platform = Platform

    @Input() hideControls: boolean

    constructor (
        public hostWindow: HostWindowService,
        public config: ConfigService,
        public hostApp: HostAppService,
    ) { }
}
