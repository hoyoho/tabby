import { Component, HostListener, OnInit, ViewChild } from '@angular/core'
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
    generation = 0
    private ctx: ActionContext = {}

    constructor (private actions: ActionRegistry) { }

    ngOnInit (): void {
        this.menus = this.actions.get(ActionSurface.Menu, this.ctx)
    }

    onOpen (opening: boolean): void {
        if (!opening) {
            return
        }
        // Remount all levels collapsed on every open (classic cascading menus).
        this.generation++
        this.menus = this.actions.get(ActionSurface.Menu, this.ctx)
    }

    /**
     * The OS window lost focus (e.g. the user clicked another application) —
     * collapse the menu.
     */
    @HostListener('window:blur')
    onWindowBlur (): void {
        this.menuDropdown?.close()
    }

    isEnabled (action: Action): boolean {
        return this.actions.isEnabled(action, this.ctx)
    }

    isChecked (action: Action): boolean {
        return action.checked ? action.checked(this.ctx) : false
    }

    /**
     * Runs a leaf action and collapses the menu. Exposed as an arrow field so
     * child menu nodes keep the correct `this` when invoked through `[onRun]`.
     */
    run = (action: Action): void => {
        this.menuDropdown?.close()
        this.actions.run(action, this.ctx)
    }
}
