import { Component, OnInit, ViewChild } from '@angular/core'
import { NgbDropdown } from '@ng-bootstrap/ng-bootstrap'
import { Action, ActionContext, ActionSurface } from '../api/action'
import { ActionRegistry } from '../services/action.service'

/** @hidden */
@Component({
    selector: 'app-menu',
    templateUrl: './appMenu.component.pug',
    styleUrls: ['./appMenu.component.scss'],
})
export class AppMenuComponent implements OnInit {
    @ViewChild('menuDropdown') menuDropdown?: NgbDropdown

    menus: Action[] = []
    expandedMenu: string|null = null
    private ctx: ActionContext = {}

    constructor (private actions: ActionRegistry) { }

    ngOnInit (): void {
        this.menus = this.actions.get(ActionSurface.Menu, this.ctx)
    }

    onOpen (opening: boolean): void {
        if (!opening) {
            return
        }
        this.menus = this.actions.get(ActionSurface.Menu, this.ctx)
    }

    isExpanded (menu: Action): boolean {
        return this.expandedMenu === (menu.id ?? menu.label)
    }

    toggle (menu: Action): void {
        const key = menu.id ?? menu.label
        this.expandedMenu = this.expandedMenu === key ? null : key
    }

    isEnabled (action: Action): boolean {
        return this.actions.isEnabled(action, this.ctx)
    }

    isChecked (action: Action): boolean {
        return action.checked ? action.checked(this.ctx) : false
    }

    run (action: Action): void {
        this.menuDropdown?.close()
        this.actions.run(action, this.ctx)
    }
}
