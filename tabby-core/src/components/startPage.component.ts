import { Component } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { HomeBaseService } from '../services/homeBase.service'
import { Action, ActionSurface } from '../api/action'
import { ActionRegistry } from '../services/action.service'

/** @hidden */
@Component({
    selector: 'start-page',
    templateUrl: './startPage.component.pug',
    styleUrls: ['./startPage.component.scss'],
})
export class StartPageComponent {
    actions: Action[] = []

    constructor (
        private domSanitizer: DomSanitizer,
        public homeBase: HomeBaseService,
        actions: ActionRegistry,
    ) {
        actions.getAsync(ActionSurface.StartPage).then(a => {
            this.actions = a
        })
    }

    sanitizeIcon (icon?: string): any {
        return this.domSanitizer.bypassSecurityTrustHtml(icon ?? '')
    }

    runAction (action: Action): void {
        action.run({})
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    buttonsTrackBy (_, action: Action): any {
        return action.label + (action.icon ?? '')
    }
}
