/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable } from '@angular/core'
import { SessionService, MenuProvider, AppMenu } from 'tabby-core'
import { BaseTerminalTabComponent } from './api/baseTerminalTab.component'

/** @hidden */
@Injectable()
export class TerminalMenuProvider extends MenuProvider {
    constructor (private session: SessionService) {
        super()
    }

    getMenus (): AppMenu[] {
        return [
            {
                label: 'Font size',
                target: 'View',
                items: [
                    {
                        label: 'Enlarge font',
                        separatorBefore: true,
                        weight: 20,
                        click: () => this.zoom(tab => tab.zoomIn()),
                        enabled: this.hasActiveTerminal(),
                    },
                    {
                        label: 'Shrink font',
                        weight: 21,
                        click: () => this.zoom(tab => tab.zoomOut()),
                        enabled: this.hasActiveTerminal(),
                    },
                    {
                        label: 'Reset zoom',
                        weight: 22,
                        click: () => this.zoom(tab => tab.resetZoom()),
                        enabled: this.hasActiveTerminal(),
                    },
                ],
            },
        ]
    }

    private hasActiveTerminal (): boolean {
        return this.getActiveTerminal() instanceof BaseTerminalTabComponent
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
