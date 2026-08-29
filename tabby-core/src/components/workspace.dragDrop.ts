import { SessionTab } from '../api/session'
import { Pane, SplitDirection, SplitContainer, collectPanes } from './workspace.layout'
import type { WorkspaceComponent } from './workspace.component'

/**
 * Pointer-drag hint overlay state, exposed to the host view-model.
 */
export interface DragHintState {
    visible: boolean
    side: SplitDirection|'all'
    x: number
    y: number
    w: number
    h: number
}

/**
 * The narrow slice of [[WorkspaceComponent]] a drag gesture needs. Keeps the
 * gesture logic free of DOM/viewRefs so it can live outside the component.
 */
export interface PaneDragHost {
    readonly root: SplitContainer
    readonly paneHeaderHeight: number

    /** DOM node of a session (its rendered pane cell), or undefined. */
    elementFor: (tab: SessionTab) => HTMLElement|undefined
    getPaneOf: (tab: SessionTab) => Pane|null
    cleanRoot: () => void
    emitTabAdopted: (tab: SessionTab) => void
    /**
     * Moves a session into/next to a pane, draining its source pane and
     * re-laying out. Single implementation shared by this gesture and the
     * native drop zones ([[WorkspaceComponent.dropTabInto]]).
     */
    dropTabInto: (tab: SessionTab, target: { pane: Pane|null, side: SplitDirection|'all', relativeTab?: SessionTab|null }) => void
    /**
     * Another top-level workspace's tab header under a point, if any — the
     * cross-workspace drop target (only the focused workspace's panes are
     * visible, so other workspaces are reached through their tab headers).
     */
    workspaceTargetAt: (x: number, y: number) => { workspace: WorkspaceComponent, rect: DOMRect } | null
    /**
     * Moves a session out of this workspace into another top-level workspace
     * (the session's view is re-homed, never destroyed).
     */
    moveSessionToWorkspace: (tab: SessionTab, target: WorkspaceComponent) => Promise<void>
    /** Updates the drag-hint view state (or null to hide it). */
    setDragHint: (hint: DragHintState|null) => void
    /**
     * The pointer left this window's bounds while dragging a session — switch
     * the gesture into cross-window mode (capture the recovery token and hand
     * control to the main-process coordinator).
     */
    beginCrossWindowDrag: (tab: SessionTab) => void
    /**
     * The pointer was released while in cross-window mode — tell the main
     * process to commit (or cancel) the drag.
     */
    endCrossWindowDrag: (tab: SessionTab) => void
    /**
     * The pointer re-entered this window mid cross-window drag — cancel the
     * main-process protocol (ghost card gone, PTY keep-alive undone) and let
     * the in-window gesture take over again.
     */
    reenterCrossWindowDrag: (tab: SessionTab) => void
}

/**
 * Pointer-based pane-tab drag (same logic as the XShell demo). Owns the
 * gesture lifecycle (threshold, hint overlay, commit) and only talks to the
 * workspace through [[PaneDragHost]].
 */
export class PaneDragController {
    private info: {
        tab: SessionTab
        pane: Pane
        startX: number
        startY: number
        active: boolean
        crossWindow: boolean
    }|null = null

    constructor (private host: PaneDragHost) {}

    /**
     * Drops any in-flight gesture: detaches the window listeners and hides the
     * hint. Must be called when the workspace is torn down mid-drag, otherwise
     * the gesture keeps a live reference to the host and continues write DOM.
     */
    abort (): void {
        if (!this.info) {
            return
        }
        this.info = null
        window.removeEventListener('pointermove', this.move)
        window.removeEventListener('pointerup', this.up)
        this.host.setDragHint(null)
    }

    begin (event: PointerEvent, tab: SessionTab): void {
        if (event.button !== 0 || this.info) { return }
        this.info = {
            tab,
            pane: this.host.getPaneOf(tab)!,
            startX: event.clientX,
            startY: event.clientY,
            active: false,
            crossWindow: false,
        }
        window.addEventListener('pointermove', this.move)
        window.addEventListener('pointerup', this.up)
    }

    private move = (event: PointerEvent): void => {
        if (!this.info) { return }
        const dx = event.clientX - this.info.startX
        const dy = event.clientY - this.info.startY
        if (!this.info.active && Math.hypot(dx, dy) > 6) { this.info.active = true }

        const sx = window.screenX + event.clientX
        const sy = window.screenY + event.clientY
        const inside = (
            sx >= window.screenX &&
            sx <= window.screenX + window.outerWidth &&
            sy >= window.screenY &&
            sy <= window.screenY + window.outerHeight
        )

        // Pointer re-entered this window while in cross-window mode: hand the
        // drag back to the in-window gesture (cancel the main-process protocol)
        // so the user can keep moving the tab inside this workspace instead of
        // accidentally dropping it onto a window underneath.
        if (this.info.crossWindow && inside) {
            this.info.crossWindow = false
            this.host.reenterCrossWindowDrag(this.info.tab)
        }

        // Pointer left this window's bounds (DIP screen coords) — switch to the
        // cross-window protocol. The main process tracks the cursor from here.
        if (this.info.active && !this.info.crossWindow) {
            if (!inside) {
                this.info.crossWindow = true
                this.host.setDragHint(null)
                this.host.beginCrossWindowDrag(this.info.tab)
                return
            }
        }
        if (this.info.active && !this.info.crossWindow) {
            this.updateDragHint(event.clientX, event.clientY)
        }
    }

    private updateDragHint (x: number, y: number): void {
        const hit = this.hitTestPane(x, y)
        if (!hit) {
            // Outside this workspace's panes: highlight another workspace's tab
            // header when the pointer hovers one, so a cross-workspace move is
            // discoverable during the gesture.
            const workspaceTarget = this.host.workspaceTargetAt(x, y)
            if (workspaceTarget) {
                const r = workspaceTarget.rect
                this.host.setDragHint({
                    visible: true,
                    side: 'all',
                    x: r.left + 4,
                    y: r.top + 4,
                    w: r.width - 8,
                    h: r.height - 8,
                })
                return
            }
            this.host.setDragHint(null)
            return
        }
        const pad = 4
        const r = hit.rect
        const hint: DragHintState = {
            visible: true,
            side: hit.side,
            x: r.left + pad,
            y: r.top + pad,
            w: r.width - pad * 2,
            h: r.height - pad * 2,
        }
        if (hit.side === 'r') {
            hint.x = r.left + r.width / 2
            hint.w = r.width / 2 - pad * 2
        } else if (hit.side === 't') {
            hint.h = r.height / 2 - pad * 2
        } else if (hit.side === 'b') {
            hint.y = r.top + r.height / 2
            hint.h = r.height / 2 - pad * 2
        } else if (hit.side === 'l') {
            hint.w = r.width / 2 - pad * 2
        }
        this.host.setDragHint(hint)
    }

    private up = (event: PointerEvent): void => {
        if (!this.info) { return }
        const info = this.info
        this.info = null
        window.removeEventListener('pointermove', this.move)
        window.removeEventListener('pointerup', this.up)
        this.host.setDragHint(null)

        if (info.crossWindow) {
            // Cross-window gesture: the drop is decided by the main process
            // (which window is under the cursor). The source workspace will
            // learn the outcome via the committed/cancelled streams.
            this.host.endCrossWindowDrag(info.tab)
            return
        }
        if (!info.active) { return }

        const target = this.hitTestPane(event.clientX, event.clientY)
        if (target) {
            this.commitDrag(info.tab, target)
            return
        }

        // Cross-workspace move: the drop landed outside every pane of this
        // workspace — check the other workspaces' tab headers.
        const workspaceTarget = this.host.workspaceTargetAt(event.clientX, event.clientY)
        if (workspaceTarget) {
            this.host.moveSessionToWorkspace(info.tab, workspaceTarget.workspace)
                .catch(err => console.error('[workspace] cross-workspace move failed:', err))
            this.host.emitTabAdopted(info.tab)
        }
    }

    private hitTestPane (x: number, y: number): { pane: Pane, side: SplitDirection|'all', rect: DOMRect }|null {
        for (const pane of collectPanes(this.host.root)) {
            const tab = pane.tab
            if (!tab) { continue }
            const el = this.host.elementFor(tab)
            if (!el) { continue }
            const rect = el.getBoundingClientRect()
            if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) { continue }

            // GoldenLayout demo semantics:
            //  - header strip & central area → merge (all)
            //  - outer 25% left/right columns → 'l' / 'r'
            //  - middle horizontal band (25%..75%), top half → 't', bottom half → 'b'
            const headerH = this.host.paneHeaderHeight
            const cw = rect.width
            const h = Math.max(rect.height - headerH, 1)
            const cx1 = rect.left
            const cy1 = rect.top + headerH

            if (y < cy1) { return { pane, side: 'all', rect } }            // header strip
            if (x >= cx1 && x <= cx1 + cw * 0.25) { return { pane, side: 'l', rect } }
            if (x >= cx1 + cw * 0.75 && x <= rect.right) { return { pane, side: 'r', rect } }
            if (y >= cy1 && y <= cy1 + h * 0.5) { return { pane, side: 't', rect } }
            if (y > cy1 + h * 0.5) { return { pane, side: 'b', rect } }
            return { pane, side: 'all', rect }
        }
        return null
    }

    private commitDrag (tab: SessionTab, target: { pane: Pane, side: SplitDirection|'all' }): void {
        // Dropping a single-tab pane onto its own edge is a no-op; a tab from a
        // multi-tab pane dragged to its own edge is allowed to split into a new pane.
        // (The `sourcePane === target.pane` check short-circuits before
        // `sourcePane.tabs` could dereference a null source pane.)
        const sourcePane = this.host.getPaneOf(tab)
        if (target.side !== 'all' && sourcePane === target.pane && sourcePane.tabs.length <= 1) {
            this.host.cleanRoot()
            return
        }
        this.host.dropTabInto(tab, { pane: target.pane, side: target.side })
        this.host.emitTabAdopted(tab)
    }
}
