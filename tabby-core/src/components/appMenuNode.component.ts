import { Component, Input } from '@angular/core'
import { Action } from '../api/action'
import { ActionRegistry } from '../services/action.service'

/** @hidden */
@Component({
    selector: 'app-menu-node',
    templateUrl: './appMenuNode.component.pug',
    styleUrls: ['./appMenuNode.component.scss'],
})
export class AppMenuNodeComponent {
    @Input() item: Action
    @Input() onRun?: (action: Action) => void
    @Input() depth = 0
    private lastResetKey: number|undefined

    // Collapse all levels every time the dropdown is reopened.
    get resetKey (): number|undefined { return this.lastResetKey }
    @Input() set resetKey (value: number|undefined) {
        if (value !== this.lastResetKey) {
            this.lastResetKey = value
            this.subOpen = false
        }
    }

    subOpen = false

    constructor (private actions: ActionRegistry) { }

    get hasChildren (): boolean {
        return !!this.item.children?.length
    }

    get hasNestedChildren (): boolean {
        return !!this.item.children?.some(child => child.children?.length)
    }

    get enabled (): boolean {
        return this.actions.isEnabled(this.item, {})
    }

    get checked (): boolean {
        return this.item.checked ? this.item.checked({}) : false
    }

    isEnabled (action: Action): boolean {
        return this.actions.isEnabled(action, {})
    }

    isChecked (action: Action): boolean {
        return action.checked ? action.checked({}) : false
    }

    setSubOpen (open: boolean): void {
        this.subOpen = open
    }

    openSub (): void {
        this.subOpen = true
    }

    runItem (action?: Action): void {
        const target = action ?? this.item
        if (this.onRun) {
            this.onRun(target)
        } else {
            this.actions.run(target, {})
        }
    }
}
