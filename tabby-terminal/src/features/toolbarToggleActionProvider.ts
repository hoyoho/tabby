import { Injectable } from '@angular/core'
import { Action, ActionContext, ActionProvider, ActionSurface, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent } from '../api/baseTerminalTab.component'

/** @hidden */
@Injectable()
export class ToolbarToggleActionProvider extends ActionProvider {
    constructor (private translate: TranslateService) { super() }

    provide (ctx: ActionContext): Action[] {
        const tab = ctx.tab ?? null
        if (!tab || !(tab instanceof BaseTerminalTabComponent)) {
            return []
        }
        // Only session types that support the hover toolbar get the toggle.
        if (!tab.enableToolbar) {
            return []
        }
        return [{
            id: 'terminal:toggle-toolbar-separator',
            label: '',
            type: 'separator',
            weight: 1000,
            surfaces: [ActionSurface.TabContext],
            run: () => undefined,
        }, {
            id: 'terminal:toggle-toolbar',
            label: this.translate.instant('Enable toolbar'),
            type: 'checkbox',
            checked: () => !!tab.toolbarEnabled,
            weight: 1000,
            surfaces: [ActionSurface.TabContext],
            run: () => tab.toggleToolbarEnabled(),
        }]
    }
}
