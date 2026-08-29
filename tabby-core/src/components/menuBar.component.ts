import { Component, OnInit } from '@angular/core'
import { Action, ActionContext, ActionSurface } from '../api/action'
import { ActionRegistry } from '../services/action.service'

/** @hidden */
@Component({
    selector: 'menu-bar',
    templateUrl: './menuBar.component.pug',
    styleUrls: ['./menuBar.component.scss'],
})
export class MenuBarComponent implements OnInit {
    menus: Action[] = []
    private ctx: ActionContext = {}

    constructor (
        private actions: ActionRegistry,
    ) { }

    ngOnInit (): void {
        this.menus = this.actions.get(ActionSurface.Menu, this.ctx)
    }

    onMenuOpen (menu: Action, opening: boolean): void {
        if (!opening) {
            return
        }
        // Refresh just the opened menu's children in place so the ngbDropdown
        // instance survives (rebuilding the whole list breaks the open state).
        const fresh = this.actions.get(ActionSurface.Menu, this.ctx).find(m => m.label === menu.label)
        if (fresh) {
            menu.children = fresh.children
        }
    }

    isEnabled (action: Action): boolean {
        return this.actions.isEnabled(action, this.ctx)
    }

    isChecked (action: Action): boolean {
        return action.checked ? action.checked(this.ctx) : false
    }

    run (action: Action): void {
        this.actions.run(action, this.ctx)
    }
}