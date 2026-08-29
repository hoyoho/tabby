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
    @Input() depth = 0
    @Input() onRun?: (action: Action) => void

    expanded = false

    constructor (private actions: ActionRegistry) { }

    get hasChildren (): boolean {
        return !!this.item.children?.length
    }

    get enabled (): boolean {
        return this.actions.isEnabled(this.item, {})
    }

    get checked (): boolean {
        return this.item.checked ? this.item.checked({}) : false
    }

    toggle (): void {
        this.expanded = !this.expanded
    }

    runItem (): void {
        if (this.onRun) {
            this.onRun(this.item)
        } else {
            this.actions.run(this.item, {})
        }
    }
}
