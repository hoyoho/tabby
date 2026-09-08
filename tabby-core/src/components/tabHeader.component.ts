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
import { TABBY_WORKSPACE_DRAG_MIME, createDragImageClone, removeDragImageClones } from './workspace.dragDrop'

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

    // Manual in-bar sortable state (non-workspace tabs). CDK's own sorting is
    // disabled (sortPredicate in AppRoot) — the placeholder clone slides along
    // the bar with the pointer, passed-over siblings shift aside, and the final
    // index is committed through app.moveTabToIndex on drop.
    private dragPlaceholder: HTMLElement|null = null
    private dragSiblings: HTMLElement[] = []
    private dragSiblingCenters: number[] = []
    private dragStripRect: DOMRect|null = null
    private dragPlaceholderBase = 0
    private dragPlaceholderSize = 0
    private dragOriginIndex = -1
    private dragTargetIndex = -1
    private dragAxis: 'x'|'y' = 'x'

    onTabDragStart (tab: BaseTabComponent) {
        this.app.emitTabDragStarted(tab)
        if (this.isWorkspaceTab) {
            return
        }
        // Geometry must be captured NOW: CDK has already swapped the header
        // for its placeholder clone and parked the original in <body>, so the
        // placeholder sits at the dragged tab's slot with no transforms yet.
        const placeholder = document.querySelector('tab-header.cdk-drag-placeholder') as HTMLElement|null
        const strip = placeholder?.parentElement as HTMLElement|null
        if (!placeholder || !strip) {
            return
        }
        const loc = this.config.store.appearance.tabsLocation
        this.dragAxis = (loc === 'left' || loc === 'right') ? 'y' : 'x'
        this.dragStripRect = strip.getBoundingClientRect()
        this.dragPlaceholder = placeholder
        const pr = placeholder.getBoundingClientRect()
        this.dragPlaceholderBase = this.dragAxis === 'x' ? pr.left : pr.top
        this.dragPlaceholderSize = this.dragAxis === 'x' ? pr.width : pr.height
        this.dragSiblings = []
        this.dragSiblingCenters = []
        strip.querySelectorAll('tab-header').forEach(el => {
            if (el === placeholder) {
                return
            }
            const header = el as HTMLElement
            const r = header.getBoundingClientRect()
            this.dragSiblings.push(header)
            this.dragSiblingCenters.push(this.dragAxis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2)
        })
        this.dragOriginIndex = this.index
        this.dragTargetIndex = this.index
    }

    /**
     * Live in-bar reorder (settings / welcome / … non-workspace tabs): the
     * placeholder clone slides with the pointer inside the bar and passed-over
     * siblings glide aside, so the tab visually swaps places with neighbours
     * without ever leaving the bar.
     */
    onTabDragMove (event: { pointerPosition?: { x: number, y: number } }): void {
        if (this.isWorkspaceTab || !this.dragPlaceholder || !this.dragStripRect) {
            return
        }
        const pointer = event.pointerPosition
        if (!pointer) {
            return
        }
        const horizontal = this.dragAxis === 'x'
        const p = horizontal ? pointer.x : pointer.y
        const stripStart = horizontal ? this.dragStripRect.left : this.dragStripRect.top
        const stripSize = horizontal ? this.dragStripRect.width : this.dragStripRect.height
        // Slide the clone with the pointer, clamped to the bar bounds.
        const slide = Math.min(
            Math.max(p - this.dragPlaceholderSize / 2, stripStart),
            stripStart + stripSize - this.dragPlaceholderSize,
        ) - this.dragPlaceholderBase
        this.dragPlaceholder.style.transform = horizontal
            ? `translate3d(${slide}px,0,0)`
            : `translate3d(0,${slide}px,0)`
        // Target slot = how many resting sibling centres the pointer passed.
        const target = this.dragSiblingCenters.filter(c => c < p).length
        if (target === this.dragTargetIndex) {
            return
        }
        this.applySiblingShifts(target)
        this.dragTargetIndex = target
    }

    private applySiblingShifts (target: number): void {
        const origin = this.dragOriginIndex
        const size = this.dragPlaceholderSize
        const horizontal = this.dragAxis === 'x'
        this.dragSiblings.forEach((el, i) => {
            // Reduced-list index (the strip without the dragged tab) → index
            // in the full tabs array.
            const tabIndex = i < origin ? i : i + 1
            let shift = 0
            if (target > origin && tabIndex > origin && tabIndex <= target) {
                shift = -size
            } else if (target < origin && tabIndex >= target && tabIndex < origin) {
                shift = size
            }
            el.style.transform = shift
                ? (horizontal ? `translate3d(${shift}px,0,0)` : `translate3d(0,${shift}px,0)`)
                : ''
        })
    }

    onTabDropped (): void {
        // Fires right after `ended`, inside the same task — CDK has already
        // restored the header to its original slot, so apply the manual
        // reorder now, before the browser can paint the snap-back.
        if (!this.isWorkspaceTab
            && this.dragPlaceholder
            && this.dragTargetIndex >= 0
            && this.dragTargetIndex !== this.dragOriginIndex) {
            this.app.moveTabToIndex(this.tab, this.dragTargetIndex)
        }
        this.resetDragState()
    }

    private snapDragVisuals (): void {
        // Snap without transitioning back: the reorder (if any) lands in the
        // same task, so a glide would double-draw the movement.
        const snap = (el: HTMLElement) => {
            el.style.transition = 'none'
            el.style.transform = ''
            requestAnimationFrame(() => {
                el.style.transition = ''
            })
        }
        if (this.dragPlaceholder) {
            snap(this.dragPlaceholder)
        }
        this.dragSiblings.forEach(snap)
    }

    private resetDragState (): void {
        this.dragPlaceholder = null
        this.dragSiblings = []
        this.dragSiblingCenters = []
        this.dragStripRect = null
        this.dragTargetIndex = -1
        this.dragOriginIndex = -1
    }

    /**
     * Workspace tabs drag through the native system DnD (like pane sessions):
     * the DataTransfer carries only a tiny {dragId} payload, the full
     * recovery token travels out-of-band to the main process, and the drag
     * image IS the real tab header (a clone with the tab's own style, icon
     * and text, handed to setDragImage), rendered by the compositor on every
     * platform. The clone is the only visual: the original header hides for
     * the drag (:host(.ws-dragging)) and comes back on a rejected drop; an
     * accepted cross-window drop destroys it on commit instead. Dropping onto
     * another window's tab bar inserts it there; dropping nowhere detaches
     * the workspace into a new window at the release point.
     */
    @HostListener('dragstart', ['$event']) onWorkspaceDragStart (event: DragEvent): void {
        const tab = this.tab
        if (!(tab instanceof WorkspaceComponent)) { return }
        const dt = event.dataTransfer
        if (!dt) { return }
        const dragId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
        dt.setData(TABBY_WORKSPACE_DRAG_MIME, JSON.stringify({ dragId }))
        dt.effectAllowed = 'move'
        // The drag image must be a DOM-attached element — a detached canvas is
        // not rendered as the drag icon on Wayland/Chromium. We park the card
        // off-viewport (not <0 opacity, which would make the snapshot blank),
        // hand it to setDragImage, and remove it on dragend.
        try {
            const host = event.currentTarget as HTMLElement
            const rect = host.getBoundingClientRect()
            const ghost = createDragImageClone(host)
            // The action buttons have no place on a drag card.
            ghost.querySelectorAll('.buttons').forEach(el => el.remove())
            const offsetX = Math.min(Math.max(event.offsetX || rect.width / 2, 8), Math.max(rect.width - 8, 8))
            const offsetY = Math.min(Math.max(event.offsetY || rect.height / 2, 8), Math.max(rect.height - 8, 8))
            dt.setDragImage(ghost, offsetX, offsetY)
        } catch {
            // setDragImage is best-effort; without an image the drag still works.
        }
        // The floating ghost replaces the in-place header for the drag.
        // Hiding the source synchronously inside dragstart aborts the whole
        // native drag (Chromium re-checks the source's visibility when the
        // dragstart task unwinds) — defer by a tick, once the drag session is
        // established.
        const sourceHeader = event.currentTarget as HTMLElement
        window.setTimeout(() => sourceHeader.classList.add('ws-dragging'), 0)
        this.app.emitTabDragStarted(tab)
        this.app.beginWorkspaceNativeDrag(tab, dragId)
    }

    /** @hidden works when the drag was accepted elsewhere / settled locally */
    @HostListener('dragend', ['$event']) onWorkspaceDragEnd (event: DragEvent): void {
        if (!(this.tab instanceof WorkspaceComponent)) { return }
        removeDragImageClones()
        // Rejected/cancelled drag: nothing accepted the ghost — bring the
        // header back. An accepted drop ('move') keeps it hidden for now: a
        // same-window drop already re-ordered it (endWorkspaceNativeDrag
        // re-shows), a cross-window drop destroys this copy on commit.
        if (event.dataTransfer?.dropEffect !== 'move') {
            ;(event.currentTarget as HTMLElement).classList.remove('ws-dragging')
        }
        this.app.emitTabDragEnded()
        this.app.endWorkspaceNativeDrag(this.tab, event.dataTransfer?.dropEffect)
    }

    onTabDragEnd (event?: any) {
        // By the time `ended` fires, CDK has already destroyed the placeholder
        // and parked the header back at its original slot; `dropped` follows in
        // the same task (onTabDropped) and applies the reorder. Just snap the
        // pushed siblings so the restored header isn't left among shifted
        // neighbours. Workspace drags end via the native dragend above.
        if (!this.isWorkspaceTab) {
            this.snapDragVisuals()
        }
        setTimeout(() => {
            this.app.hideTabReorderHint()
            // A cancelled/interrupted CDK drag can leave a preview clone of the
            // dragged tab-header attached to the body; drop any `tab-header`
            // that is not inside the strip so it can never skew tab counts.
            document.querySelectorAll('tab-header').forEach(h => {
                if (!h.closest('.tab-bar')) {
                    h.remove()
                }
            })
            this.app.emitTabDragEnded()
            this.app.emitTabsChanged()
        })
    }

    @HostBinding('class.flex-width') get isFlexWidthEnabled (): boolean {
        return this.config.store.appearance.flexTabs
    }

    /** Native (non-CDK) drag source: top-level workspace tabs use system DnD. */
    get isWorkspaceTab (): boolean {
        return this.tab instanceof WorkspaceComponent
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
