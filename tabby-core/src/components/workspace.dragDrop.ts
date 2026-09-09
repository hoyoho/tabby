import { Subscription } from 'rxjs'
import { SessionTab } from '../api/session'
import { SplitContainer, Pane, SplitDirection } from './workspace.layout'
import type { WorkspaceComponent } from './workspace.component'

/**
 * Drag-hint overlay geometry, exposed to the host view-model. The shape already
 * encodes the drop zone (full-body merge vs carved side); the component draws
 * it as a plain rect.
 */
export interface DragHintState {
    visible: boolean
    x: number
    y: number
    w: number
    h: number
}

/**
 * A point→zone hit-test result over the active workspace's panes.
 *
 * `side` is the split direction ('l'/'r'/'t'/'b') or 'all'. The header strip
 * and body centre resolve to 'all' — the session joins the pane as a tab (the
 * active one is shown, the rest collapse into the header). Only the body
 * edge/band zones split. `rect` is the pane's full cell box in client coords.
 */
export interface PaneHit {
    pane: Pane
    side: SplitDirection|'all'
    rect: { left: number, top: number, width: number, height: number }
}

/** True when a dragleave really left the document — inter-element
  * transitions fire dragleave too, and must not end the gesture. */
export function dragLeftDocument (event: DragEvent): boolean {
    return !event.relatedTarget || (event.relatedTarget as Node).ownerDocument !== document
}

/** Unique id tagging a native drag gesture (renderer-local correlation only). */
export function generateDragId (): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * The narrow slice of [[WorkspaceComponent]] a drag gesture needs. Keeps the
 * gesture logic free of DOM/viewRefs so it can live outside the component.
 */
export interface PaneDragHost {
    readonly root: SplitContainer
    readonly paneHeaderHeight: number

    /** Whether this workspace is the window's active top-level tab. */
    readonly isActiveWorkspace: boolean

    getPaneOf: (tab: SessionTab) => Pane|null
    /** The canonical display title (custom name → profile name → dynamic). */
    sessionDisplayTitle: (tab: SessionTab) => string
    cleanRoot: () => void
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
    /** Moves a session out of this workspace into another top-level workspace. */
    moveSessionToWorkspace: (tab: SessionTab, target: WorkspaceComponent) => Promise<void>
    /** Updates the drag-hint view state (or null to hide it). */
    setDragHint: (hint: DragHintState|null) => void
    /**
     * Chrome demo of a point→zone hit-test over the pane CELL boxes (computed
     * from the layout, never the mid-transition DOM): header strip → 'all'
     * (merge into that pane); body centre → 'all'; body left/right 25% columns
     * → 'l'/'r'; body upper/lower half → 't'/'b'. Cells are disjoint, so a
     * point can only ever match its own pane.
     */
    paneHit: (x: number, y: number) => PaneHit|null
    /** Client rect of the workspace's host element, or null if unavailable. */
    hostRect: () => { left: number, top: number, width: number, height: number }|null

    /**
     * Register a native drag id (+ serialized screen state) with the main
     * process (source side). The state is fetched by the target by id on drop —
     * see [[getNativeDragState]].
     */
    beginNativeDrag: (dragId: string, savedState: any) => void
    /** Release the registration (source side; no committed cross-window drop). */
    endNativeDrag: (dragId: string) => void
    /**
     * Receiving side: fetch the source's serialized screen state registered
     * under a drag id, or null if the source already released the drag.
     */
    getNativeDragState: (dragId: string) => any
    /** The receiving window restored the dragged session — notify the source. */
    acceptNativeDrag: (dragId: string) => void
    /**
     * Subscribe to cross-window commit notifications, keyed by drag id.
     * Returns the subscription (call cleanup on cancel).
     */
    onNativeDragCommitted: (handler: (dragId: string) => void) => Subscription
    /** Keep (true) or restore (false) the PTY keep-alive of a session. */
    keepSessionAlive: (tab: SessionTab, alive: boolean) => void
    /**
     * Receiving side: rebuild a session from the dragged payload, insert it at
     * the client point's pane zone (or the focused pane when outside any zone).
     * Returns whether the session was successfully restored.
     */
    acceptProfileIntoWorkspace: (payload: NativeDragPayload, x: number, y: number) => Promise<boolean>
}

/** Mime type used to carry the drag payload between Electron windows. */
export const TABBY_DRAG_MIME = 'application/x-tabby-session'

/** Mime type for top-level workspace tab drags (native system DnD). */
export const TABBY_WORKSPACE_DRAG_MIME = 'application/x-tabby-workspace'

// ----------------------------------------------------------------------------
// Global "a Tabby window is dragged over" tracker (VSCode dnd.ts parity).
//
// The native drag reports a successful dropEffect even when a FOREIGN drop
// target (another app) ate the release — the dropEffect is useless for
// deciding "did one of OUR windows get it". What actually answers that is
// whether any Tabby window saw dragover and not yet dragleave, synced across
// windows over a BroadcastChannel and read synchronously at dragend.
// ----------------------------------------------------------------------------

const DRAGGED_OVER_CHANNEL = 'tabby-workspace-dragged-over'

let draggedOver = false
let draggedOverChannel: BroadcastChannel|null = null

function setDraggedOver (value: boolean, broadcast: boolean): void {
    if (draggedOver === value) {
        return
    }
    draggedOver = value
    if (broadcast) {
        draggedOverChannel?.postMessage(value)
    }
}

/** Installs the per-window listeners (once per window, from AppService). */
export function setupWorkspaceDraggedOverTracking (): void {
    if (draggedOverChannel) {
        return
    }
    try {
        draggedOverChannel = new BroadcastChannel(DRAGGED_OVER_CHANNEL)
        draggedOverChannel.onmessage = event => setDraggedOver(event.data === true, false)
    } catch {
        draggedOverChannel = null
    }
    window.addEventListener('dragover', () => setDraggedOver(true, true), true)
    // Only leaving the DOCUMENT clears the flag — inter-element transitions
    // fire dragleave too, and the next dragover immediately re-sets it.
    window.addEventListener('dragleave', event => {
        if (dragLeftDocument(event)) {
            setDraggedOver(false, true)
        }
    }, true)
}

/** Whether any Tabby window is currently hovered by a native drag. */
export function isWorkspaceDraggedOver (): boolean {
    return draggedOver
}

/** First fully-opaque `background-color` found walking up from `source`. */
function opaqueAncestorBackground (source: HTMLElement): string|null {
    let el: HTMLElement|null = source.parentElement
    while (el) {
        const bg = getComputedStyle(el).backgroundColor
        // Computed styles render opaque colors as `rgb(...)`; translucent ones
        // carry an explicit alpha in `rgba(...)`.
        if (bg.startsWith('rgb(')) {
            return bg
        }
        const match = /^rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)$/.exec(bg)
        if (match && parseFloat(match[4]) >= 0.99) {
            return `rgb(${match[1]}, ${match[2]}, ${match[3]})`
        }
        el = el.parentElement
    }
    return null
}

/**
 * Builds the native drag image as a faithful snapshot of the source element:
 * the element is cloned with its full computed style inlined on the root, so
 * the card looks exactly like it did in place even though the ancestor-context
 * selectors (tab bar / pane header chrome) no longer match once the clone is
 * parked outside its DOM tree. The clone must stay rendered and DOM-attached
 * for setDragImage (Wayland/Chromium) — it parks off-viewport; callers remove
 * it via [[removeDragImageClones]] on dragend.
 *
 * The clone sits on a backing painted with the first OPAQUE ancestor
 * background: an inactive tab header (or a vibrancy theme's translucent
 * `--body-bg`) has no background of its own — in the bar the strip shows
 * through, but a drag image floats over arbitrary content and would render
 * as a ghostly outline without a solid base.
 */
export function createDragImageClone (source: HTMLElement): HTMLElement {
    const rect = source.getBoundingClientRect()
    const clone = source.cloneNode(true) as HTMLElement
    const computed = getComputedStyle(source)
    for (let i = 0; i < computed.length; i++) {
        const prop = computed.item(i)
        clone.style.setProperty(prop, computed.getPropertyValue(prop))
    }
    // Re-anchor: the snapshot must not inherit the in-place layout position,
    // any mid-drag transform, or intercept input.
    clone.style.cssText += ';position:relative;left:0;top:0;pointer-events:none;'
    clone.style.width = `${rect.width}px`
    clone.style.height = `${rect.height}px`
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-tabby-drag-ghost', '')
    wrapper.style.cssText = 'position:fixed;left:-10000px;top:0;margin:0;pointer-events:none;' +
        `z-index:2147483647;box-sizing:border-box;width:${rect.width}px;height:${rect.height}px;` +
        'display:block;overflow:hidden;' +
        // 8px, matching the CDK drag chip and the pane tear-off card — all
        // three drag visuals share the same rounding.
        'border-radius:8px;background:' + (opaqueAncestorBackground(source) ?? '#2b2f36') + ';'
    wrapper.appendChild(clone)
    document.body.appendChild(wrapper)
    return wrapper
}

/** Removes every parked drag-image clone (call on dragend). */
export function removeDragImageClones (): void {
    document.querySelectorAll('[data-tabby-drag-ghost]').forEach(el => el.remove())
}

/** Payload set on dragstart and read on drop. */
export interface NativeDragPayload {
    dragId: string
    profile: any
    /** xterm serialized screen state, so the receiving window restores content. */
    savedState: any
}

/** Tiny workspace-drag payload (the recovery token travels out-of-band). */
export interface WorkspaceDragPayload {
    dragId: string
}

interface NativeDragState {
    dragId: string
    tab: SessionTab
    committed: boolean
    committedSub: Subscription
    fallbackTimer: ReturnType<typeof setTimeout>|null
}

/**
 * Gesture logic for the native (HTML5/system DnD) pane-tab drag.
 *
 * The OS owns the drag session end-to-end: the compositor follows the cursor
 * with the drag image and routes it to whichever window is underneath (this is
 * what makes cross-window moves feel native on Wayland). This controller only
 * (a) seeds the DataTransfer payload at dragstart, (b) previews the in-window
 * drop hint as the pointer crosses panes, and (c) resolves the drop — locally
 * (rebuild/merge inside this workspace) or cross-window (restore the session
 * and tell the main process to release the source).
 */
export class PaneDragController {
    private state: NativeDragState|null = null

    /**
     * The drop zone decided by the LAST dragover — the same decision that drew
     * the highlight. Single source of truth: cursor (accept gate), highlight
     * and landing all flow from it, so a drop always lands exactly where the
     * highlight is shown.
     */
    private lastZone: {
        type: 'pane'
        pane: Pane|null
        side: SplitDirection|'all'
    } | {
        type: 'workspace'
        workspace: WorkspaceComponent
    } | null = null

    constructor (private host: PaneDragHost) {}

    /** Let the pane-seam splitter gutters fall through to the panes while a
     * native session drag hovers this window (see workspace.component.scss
     * body.ws-pane-drag). */
    private gutterPassthrough (on: boolean): void {
        document.body.classList.toggle('ws-pane-drag', on)
    }

    /**
     * Preview the drop zone for a client point and answer whether the drop is
     * accepted there. The SAME hit-test both decides the dataTransfer.dropEffect
     * (the cursor) and draws the highlight, so the two can never disagree: a
     * pane cell (header → merge / edges → split) or another workspace's tab
     * header → accepted; anywhere else → rejected and no highlight.
     * @returns true when a drop zone exists at the point (highlight shown).
     */
    updateDragHint (x: number, y: number): boolean {
        const hit = this.host.paneHit(x, y)
        if (!hit) {
            // Outside this workspace's panes: highlight another workspace's tab
            // header when the pointer hovers one, so a cross-workspace move is
            // discoverable during the gesture.
            const workspaceTarget = this.host.workspaceTargetAt(x, y)
            if (workspaceTarget) {
                const r = workspaceTarget.rect
                this.host.setDragHint({
                    visible: true,
                    x: r.left + 4,
                    y: r.top + 4,
                    w: r.width - 8,
                    h: r.height - 8,
                })
                this.lastZone = { type: 'workspace', workspace: workspaceTarget.workspace }
                return true
            }
            // An EMPTY workspace has no pane cells to hit; still accept the
            // whole canvas so a session dragged in becomes the first pane.
            if (this.host.root.children.length === 0) {
                const r = this.host.hostRect()
                if (r && x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) {
                    this.host.setDragHint({
                        visible: true,
                        x: r.left + 4,
                        y: r.top + 4,
                        w: r.width - 8,
                        h: r.height - 8,
                    })
                    this.lastZone = { type: 'pane', pane: null, side: 'all' }
                    return true
                }
            }
            this.host.setDragHint(null)
            this.lastZone = null
            return false
        }
        // No-op zone suppression: hovering the dragged session's OWN pane
        // offers nothing — merging ('all') puts it right back where it lives,
        // and a single-tab pane cannot split onto its own edge (commitDrag
        // would no-op it). Neither deserves a highlight or an accept: the
        // dragover is rejected here, the cursor shows no-drop and a release
        // snaps the session back. Multi-tab panes keep their split bands
        // (splitting a sibling session off IS meaningful). Cross-window drags
        // have no local state and are never suppressed.
        const dragged = this.state?.tab
        if (dragged && hit.pane === this.host.getPaneOf(dragged)) {
            const singleTabPane = (hit.pane?.tabs.length ?? 1) <= 1
            if (hit.side === 'all' || singleTabPane) {
                this.host.setDragHint(null)
                this.lastZone = null
                return false
            }
        }
        this.lastZone = { type: 'pane', pane: hit.pane, side: hit.side }
        // HEAD hint geometry verbatim: the highlight box is drawn over the
        // pane BODY rect (paneHit's rect already excludes the header chip
        // strip, so the title strip is never tinted) — hovering the merge band
        // lights the WHOLE area ('all' = 并列), the split bands carve half.
        const pad = 4
        const r = hit.rect
        const hint: DragHintState = {
            visible: true,
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
        return true
    }

    commitDrag (tab: SessionTab, target: { pane: Pane, side: SplitDirection|'all' }): void {
        // Dropping a single-tab pane onto its own edge is a no-op; a tab from a
        // multi-tab pane dragged to its own edge is allowed to split into a new pane.
        // (The `sourcePane === target.pane` check short-circuits before
        // `sourcePane.tabs` could dereference a null source pane.)
        const sourcePane = this.host.getPaneOf(tab)
        if (target.side !== 'all' && sourcePane === target.pane && (sourcePane?.tabs.length ?? 1) <= 1) {
            this.host.cleanRoot()
            return
        }
        this.host.dropTabInto(tab, { pane: target.pane, side: target.side })
    }

    /**
     * dragstart: seed the system drag with our payload (id + livened profile),
     * keep the PTY alive so a later cross-window restore can re-attach it, and
     * register the drag id so a drop in another window resolves back here.
     */
    beginNativeDrag (event: DragEvent, tab: SessionTab): void {
        if (event.button !== 0) {
            return
        }
        if (this.state) {
            this.cancelState()
        }
        const dragId = generateDragId()
        const profile = {
            ...(tab.getProfile() ?? {}),
            options: {
                ...(tab.getProfile()?.options ?? {}),
                restoreFromPTYID: (tab as any).session?.getID?.() ?? null,
            },
        }
        // The serialized screen state is intentionally NOT embedded in the
        // DataTransfer payload — custom blobs crossing the compositor between
        // windows are size-limited and intermittently dropped, killing the drop.
        // Register it with the main process instead; the drop target fetches it
        // by drag id ([[PaneDragHost.getNativeDragState]]).
        const savedState = (tab as any).frontend?.saveState?.() ?? null
        const payload: NativeDragPayload = { dragId, profile, savedState: null }
        event.dataTransfer!.setData(TABBY_DRAG_MIME, JSON.stringify(payload))
        event.dataTransfer!.effectAllowed = 'move'

        // Torn-off tab card (neither the old blank ghost nor a raw header
        // clone): a dark rounded chip with the session title — deliberately
        // icon-less (icon fonts render unreliably inside drag snapshots and
        // the user prefers a text-only card). The snapshot root is a
        // transparent-padded WRAPPER and the shadow lives on the inner card —
        // a drag bitmap clips at the element bounds, so a shadow drawn on the
        // snapshot root itself would be cut into a faint right-angled halo.
        try {
            const wrap = document.createElement('div')
            wrap.setAttribute('data-tabby-drag-ghost', '')
            wrap.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none;z-index:2147483647;padding:24px;'
            const card = document.createElement('div')
            card.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:0 12px;height:30px;border-radius:8px;' +
                'background:#2b2f36;color:#fff;font:600 13px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;' +
                'border:1px solid rgba(255,255,255,.28);box-shadow:0 6px 18px rgba(0,0,0,.4);' +
                'white-space:nowrap;max-width:200px;overflow:hidden'
            const label = document.createElement('span')
            label.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis'
            label.textContent = this.host.sessionDisplayTitle(tab) || tab.title
            card.appendChild(label)
            wrap.appendChild(card)
            document.body.appendChild(wrap)
            // Keep the cursor anchored at the same point ON the card.
            event.dataTransfer!.setDragImage(wrap, 44, 39)
        } catch {
            // setDragImage is best-effort; without an image the drag still works.
        }

        // Until the drop is resolved the PTY must survive the source tab being
        // torn down (cross-window restore re-attaches it by id).
        this.host.keepSessionAlive(tab, true)

        const committedSub = this.host.onNativeDragCommitted(id => {
            if (this.state?.dragId !== id) { return }
            this.finishCommitted()
        })
        this.state = {
            dragId,
            tab,
            committed: false,
            committedSub,
            fallbackTimer: null,
        }
        this.host.beginNativeDrag(dragId, savedState)
    }

    /**
     * dragover on the receiving/source document: preview the drop zone and
     * accept the drop (`dropEffect = 'move'`) — but ONLY where [[updateDragHint]]
     * draws a highlight, so the cursor and the preview are decided by the same
     * hit-test. Other listeners return without side effects so CDK / other DnD
     * flows through untouched.
     */
    onNativeDragOver (event: DragEvent): void {
        if (!event.dataTransfer || !event.dataTransfer.types?.includes(TABBY_DRAG_MIME)) {
            return
        }
        if (!this.host.isActiveWorkspace) {
            return
        }
        this.acceptDragEvent(event)
    }

    /**
     * dragenter. Chromium decides the drag cursor from the DRAGENTER of a drop
     * target, not the following dragover: accepting only on dragover leaves the
     * OS showing the no-drop cursor over otherwise-valid spots (e.g. the 1px
     * boundary between a pane header and its body). Accept here with the same
     * hit-test so the cursor is `move` from the moment the pointer enters.
     */
    onNativeDragEnter (event: DragEvent): void {
        if (!event.dataTransfer || !event.dataTransfer.types?.includes(TABBY_DRAG_MIME)) {
            return
        }
        if (!this.host.isActiveWorkspace) {
            return
        }
        this.acceptDragEvent(event)
    }

    private acceptDragEvent (event: DragEvent): void {
        if (!event.dataTransfer) {
            return
        }
        if (!this.updateDragHint(event.clientX, event.clientY)) {
            return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        this.gutterPassthrough(true)
    }

    /** Whether this controller started the drag with the given id (it is the
      * single owner of its resolution — see [[resolveOwnDrop]]). */
    ownsDrag (dragId: string): boolean {
        return this.state?.dragId === dragId
    }

    /**
     * drop resolution for THIS controller's own drag, invoked exclusively by
     * the per-window drop router (AppService) — never by a document listener.
     * Single-owner by construction: the gesture state lives only here, so the
     * landing is decided exactly once, from the zone the user saw highlighted.
     * Cross-window restores are NOT handled here (the router routes foreign
     * drags to the active workspace's [[PaneDragHost.acceptProfileIntoWorkspace]]).
     */
    resolveOwnDrop (event: DragEvent): void {
        event.preventDefault()
        // A drop of any kind finalizes the preview — clear it first so NO drop
        // path can leave a stale highlight.
        const zone = this.lastZone
        this.resetDropPreview()
        if (!this.state) {
            return
        }
        // Land on the zone that was highlighted (the last dragover decision) —
        // nothing is recomputed here, so the drop is always exactly what the
        // user saw.
        if (zone?.type === 'workspace' && zone.workspace !== (this.state.tab.parent as any)) {
            void this.host.moveSessionToWorkspace(this.state.tab, zone.workspace)
        } else if (zone?.type === 'pane' && zone.pane) {
            this.commitDrag(this.state.tab, { pane: zone.pane, side: zone.side })
        } else {
            // No live highlight at the drop point — treat as cancelled,
            // keep the tab where it was.
            this.cancelState()
            return
        }
        this.host.keepSessionAlive(this.state.tab, false)
        this.completeLocally()
    }

    /**
     * dragend on the source element: if the drop was accepted somewhere else
     * the [[nativeDragCommitted$]] notification will settle the source; if it
     * ended on nothing, restore the session in place.
     */
    endNativeDrag (event: DragEvent): void {
        // The drag is over — no more dragover events will update the hint, so
        // clear it unconditionally (dropped on desktop, another app, or
        // settled locally). Leaving it stale would show a phantom drop zone.
        removeDragImageClones()
        this.resetDropPreview()
        if (!this.state) { return }
        const state = this.state
        const commit = event.dataTransfer?.dropEffect === 'move'
        if (commit) {
            // Accepted by a target window (or already settled locally). Wait a
            // bounded window for the committed round-trip; if the target's
            // restore failed (it never acknowledges) fall back to keeping the
            // session here.
            state.fallbackTimer = setTimeout(() => {
                if (this.state === state && !state.committed) {
                    this.cancelState()
                }
            }, 3000)
            return
        }
        // Dropped on nothing (desktop / rejected): keep the session here.
        this.cancelState()
    }

    /** Dragged away and the target restored it — drop the local copy. */
    private finishCommitted (): void {
        const state = this.state
        if (!state) { return }
        state.committed = true
        state.committedSub.unsubscribe()
        if (state.fallbackTimer) {
            clearTimeout(state.fallbackTimer)
            state.fallbackTimer = null
        }
        // The PTY keep-alive routes session teardown into the detach path; the
        // target window re-attached it already. Destroy the source outright —
        // its keep-alive flag survives to the session's destroy().
        const tab = state.tab
        this.state = null
        this.host.keepSessionAlive(tab, true)
        void tab.destroy()
        this.host.cleanRoot()
    }

    /** Safe teardown that keeps the session alive in this window. */
    private cancelState (): void {
        const state = this.state
        if (!state) { return }
        this.state = null
        this.resetDropPreview()
        state.committedSub.unsubscribe()
        if (state.fallbackTimer) {
            clearTimeout(state.fallbackTimer)
            state.fallbackTimer = null
        }
        this.host.keepSessionAlive(state.tab, false)
        this.host.endNativeDrag(state.dragId)
    }

    /** Local (same-window) drop: commit and settle without destroying. */
    private completeLocally (): void {
        const state = this.state
        if (!state) { return }
        state.committed = true
        state.committedSub.unsubscribe()
        this.state = null
        this.host.endNativeDrag(state.dragId)
    }


    /** @hidden teardown (e.g. component destroyed mid-gesture) */
    abort (): void {
        this.cancelState()
        this.resetDropPreview()
    }

    /**
     * Drop the drop-zone preview without touching the drag state. Used when a
     * native drag leaves this window (dragleave) — the state lives in the
     * source window and stays live; a later dragover re-arms the hint.
     */
    clearHint (): void {
        this.resetDropPreview()
    }

    /** Clears the drop-zone preview: highlight geometry + gutter interception. */
    private resetDropPreview (): void {
        this.lastZone = null
        this.host.setDragHint(null)
        this.gutterPassthrough(false)
    }
}
