import { Component, NgZone, Input } from '@angular/core'
import { Action, ActionContext, ActionRegistry, ActionSurface } from 'tabby-core'
import { BaseTerminalTabComponent } from '../api/baseTerminalTab.component'

/** @hidden */
@Component({
    selector: 'terminal-toolbar',
    host: { class: 'terminal-toolbar' },
    templateUrl: './terminalToolbar.component.pug',
    styleUrls: ['./terminalToolbar.component.scss'],
})
export class TerminalToolbarComponent {
    @Input() tab?: BaseTerminalTabComponent<any>
    buttons: Action[] = []

    get pinned (): boolean {
        return !!(this.tab?.pinToolbar)
    }

    constructor (
        private actions: ActionRegistry,
        private zone: NgZone,
    ) { }

    ngOnChanges (): void {
        this.refresh()
    }

    run (action: Action, $event: MouseEvent): void {
        $event.stopPropagation()
        this.zone.runOutsideAngular(() => {
            this.actions.run(action, { tab: this.tab, session: null })
        })
    }

    togglePin (): void {
        this.tab?.togglePinToolbar()
    }

    refresh (): void {
        const ctx: ActionContext = { tab: this.tab ?? null }
        this.buttons = this.actions.get(ActionSurface.TerminalToolbar, ctx)
    }
}