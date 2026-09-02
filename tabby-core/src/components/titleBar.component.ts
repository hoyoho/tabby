import { Component, Input, Optional } from '@angular/core'
import { HostWindowService, HostAppService, Platform, DockingService } from '../api'
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
        @Optional() private docking?: DockingService,
    ) { }

    isDocked (): boolean {
        return !!this.docking?.isDocked
    }
}
