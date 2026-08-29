/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable } from '@angular/core'
import { ToolbarButtonProvider, ToolbarButton, AppService, TranslateService } from 'tabby-core'

/** @hidden */
@Injectable()
export class ButtonProvider extends ToolbarButtonProvider {
    constructor (
        private app: AppService,
        private translate: TranslateService,
    ) {
        super()
    }

    provide (): ToolbarButton[] {
        return [
            {
                icon: require('./icons/plus.svg'),
                title: this.translate.instant('New workspace'),
                touchBarNSImage: 'NSTouchBarAddDetailTemplate',
                click: () => {
                    this.app.createWorkspaceTab()
                },
            },
        ]
    }
}
