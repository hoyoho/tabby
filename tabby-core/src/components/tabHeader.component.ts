/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Input, HostBinding, HostListener, NgZone } from '@angular/core'
import { auditTime } from 'rxjs'
import { BaseTabComponent } from './baseTab.component'
import { WorkspaceComponent } from './workspace.component'
import { HotkeysService } from '../services/hotkeys.service'
import { AppService } from '../services/app.service'
import { HostAppService, Platform } from '../api/hostApp'
import { ConfigService } from '../services/config.service'
import { BaseComponent } from './base.component'
import { MenuItemOptions } from '../api/menu'
import { PlatformService } from '../api/platform'
import { ActionSurface } from '../api/action'
import { actionsToMenuItems } from '../api/adapters'
import { ActionRegistry } from '../services/action.service'

/** @hidden */
@Component({
    selector: 'tab-header',
    templateUrl: './tabHeader.component.pug',
    styleUrls: ['./tabHeader.component.scss'],
})
export class TabHeaderComponent extends BaseComponent {
    @Input() index: number
    @Input() @HostBinding('class.active') active: boolean
    @Input() tab: BaseTabComponent
    @Input() progress: number|null
    Platform = Platform

    constructor (
        public app: AppService,
        public config: ConfigService,
        public hostApp: HostAppService,
        private hotkeys: HotkeysService,
        private platform: PlatformService,
        private zone: NgZone,
        private actions: ActionRegistry,
    ) {
        super()
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, (hotkey) => {
            if (this.app.activeTab === this.tab) {
                if (hotkey === 'rename-tab') {
                    this.app.renameTab(this.tab)
                }
            }
        })
    }

    ngOnInit () {
        this.subscribeUntilDestroyed(this.tab.progress$.pipe(
            auditTime(300),
        ), progress => {
            this.zone.run(() => {
                this.progress = progress
            })
        })
    }

    async buildContextMenu (): Promise<MenuItemOptions[]> {
        // Provider sections are grouped by the registry (one separator between
        // adjacent provider sections), mirroring the legacy per-provider loop.
        const actions = await this.actions.getAsync(ActionSurface.TabContext, { tab: this.tab, tabHeader: true })
        return actionsToMenuItems(actions, { tab: this.tab })
    }

    onTabDragStart (tab: BaseTabComponent) {
        this.app.emitTabDragStarted(tab)
        if (tab instanceof WorkspaceComponent) {
            // Cross-window workspace drag: don't activate the cross-window
            // protocol (and its ghost card) until the pointer actually leaves
            // this window — a plain in-window reorder must keep the native CDK
            // drag look with no ghost card popping up.
            this.crossWindowArmed = false
            if (this.hostApp.platform !== Platform.Web) {
                this.crossWindowMoveListener = (e: PointerEvent) => {
                    const sx = window.screenX + e.clientX
                    const sy = window.screenY + e.clientY
                    const inside = (
                        sx >= window.screenX &&
                        sx <= window.screenX + window.outerWidth &&
                        sy >= window.screenY &&
                        sy <= window.screenY + window.outerHeight
                    )
                    if (this.crossWindowArmed && inside) {
                        // The pointer re-entered the window: abort the
                        // cross-window protocol and hand control back to the
                        // native CDK reorder so the user can keep sorting tabs
                        // in this window (no lingering ghost card).
                        this.abortCrossWindowWorkspaceDrag(tab)
                        return
                    }
                    if (!this.crossWindowArmed && !inside) {
                        // Locked into cross-window mode from here on: swap the
                        // native CDK drag look for the ghost card, without
                        // flickering back if the pointer briefly re-enters.
                        this.armCrossWindowWorkspaceDrag(tab)
                    }
                }
                window.addEventListener('pointermove', this.crossWindowMoveListener)
            }
        }
    }

    private crossWindowArmed = false
    private crossWindowMoveListener: ((e: PointerEvent) => void)|null = null

    private armCrossWindowWorkspaceDrag (tab: WorkspaceComponent): void {
        if (this.crossWindowArmed) { return }
        this.crossWindowArmed = true
        document.body.classList.add('tabby-cross-window-drag')
        void this.app.startWorkspaceCrossWindowDrag(tab, () => this.crossWindowArmed)
    }

    private abortCrossWindowWorkspaceDrag (tab: WorkspaceComponent): void {
        if (!this.crossWindowArmed) { return }
        this.crossWindowArmed = false
        document.body.classList.remove('tabby-cross-window-drag')
        this.app.cancelWorkspaceCrossWindowDrag(tab)
    }

    onTabDragEnd (event?: any) {
        const armed = this.crossWindowArmed
        this.crossWindowArmed = false
        if (this.crossWindowMoveListener) {
            window.removeEventListener('pointermove', this.crossWindowMoveListener)
            this.crossWindowMoveListener = null
        }
        document.body.classList.remove('tabby-cross-window-drag')
        if (armed && this.tab instanceof WorkspaceComponent) {
            // Released while the cross-window protocol was still engaged.
            this.app.emitTabDragEnded()
            this.app.endWorkspaceCrossWindowDrag(this.tab)
            return
        }
        // In-window reorder (never left, or returned and was handed back):
        // CDK finished normally; there's nothing else to do.
        setTimeout(() => {
            this.app.emitTabDragEnded()
            this.app.emitTabsChanged()
        })
    }

    @HostBinding('class.flex-width') get isFlexWidthEnabled (): boolean {
        return this.config.store.appearance.flexTabs
    }

    @HostListener('dblclick', ['$event']) onDoubleClick (event: MouseEvent): void {
        // Whole-page hosts (settings / welcome / release notes) are not
        // renameable — only workspaces are.
        if (this.tab instanceof WorkspaceComponent) {
            this.app.renameTab(this.tab)
        }
        // Stop the dblclick from bubbling to the tab-bar's own handler, which
        // toggles window maximization when the tab bar doubles as the title
        // bar (frameless layout). The app menu is a sibling of the tab headers
        // and is unaffected.
        event.stopPropagation()
    }

    @HostListener('mousedown', ['$event']) async onMouseDown ($event: MouseEvent) {
        if ($event.which === 2) {
            $event.preventDefault()
        }
    }

    @HostListener('mouseup', ['$event']) async onMouseUp ($event: MouseEvent) {
        if ($event.which === 2) {
            this.app.closeTab(this.tab, true)
        }
    }

    @HostListener('contextmenu', ['$event']) async onContextMenu ($event: MouseEvent) {
        $event.preventDefault()
        this.platform.popupContextMenu(await this.buildContextMenu(), $event)
    }
}
