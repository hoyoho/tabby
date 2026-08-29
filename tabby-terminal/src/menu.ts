/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable, Injector } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import { SessionService, MenuProvider, AppMenu } from 'tabby-core'
import { BaseTerminalTabComponent } from './api/baseTerminalTab.component'

/** @hidden */
@Injectable()
export class TerminalMenuProvider extends MenuProvider {
    private translate: TranslateService|undefined

    constructor (
        private injector: Injector,
        private session: SessionService,
    ) {
        super()
    }

    private t (str: string): string {
        try {
            this.translate ??= this.injector.get(TranslateService)
            return this.translate.instant(str)
        } catch {
            return str
        }
    }

    getMenus (): AppMenu[] {
        return [
            {
                label: this.t('Font size'),
                target: 'View',
                items: [
                    {
                        label: this.t('Enlarge font'),
                        separatorBefore: true,
                        weight: 20,
                        click: () => this.zoom(tab => tab.zoomIn()),
                        enabled: this.hasActiveTerminal(),
                    },
                    {
                        label: this.t('Shrink font'),
                        weight: 21,
                        click: () => this.zoom(tab => tab.zoomOut()),
                        enabled: this.hasActiveTerminal(),
                    },
                    {
                        label: this.t('Reset zoom'),
                        weight: 22,
                        click: () => this.zoom(tab => tab.resetZoom()),
                        enabled: this.hasActiveTerminal(),
                    },
                ],
            },
        ]
    }

    private hasActiveTerminal (): boolean {
        try {
            return this.getActiveTerminal() instanceof BaseTerminalTabComponent
        } catch {
            return false
        }
    }

    private getActiveTerminal (): BaseTerminalTabComponent<any>|null {
        const focused = this.session.getFocused()
        return focused instanceof BaseTerminalTabComponent ? focused : null
    }

    private zoom (action: (tab: BaseTerminalTabComponent<any>) => void): void {
        const tab = this.getActiveTerminal()
        if (tab) {
            action(tab)
        }
    }
}
