import type { PanePlacement } from './workspace.layout'
import type { PaneHit } from './workspace.dragDrop'

export interface ScreenRect {
    left: number
    top: number
    width: number
    height: number
}

export interface HeaderHit {
    pane: PaneHit['pane']
    targetIndex: number
    lineX: number
    headerRect: ScreenRect
    bodyRect: ScreenRect
}

interface HitTestOptions {
    x: number
    y: number
    /** Client rect of the split-tab host, i.e. the origin of `cells`. */
    origin: { left: number, top: number }
    cells: PanePlacement[]
    headerHeight: number
}

/**
 * GoldenLayout-demo hit test over the pane CELL boxes. Cells come from the
 * layout pass, never from `getBoundingClientRect` of the mid-transition
 * terminal DOM, so a drop can only resolve to the pane whose highlight is
 * showing. The pane's header chip strip is handled by [[headerHitAt]], so this
 * body hit-test skips it. The merge zone ('all') is the UPPER BAND of the pane
 * BODY; below it: left/right 25% columns → 'l'/'r', upper/lower remainder →
 * 't'/'b'. Gutter seams between panes are deliberately not drop targets.
 */
export function paneHitAt (options: HitTestOptions): PaneHit|null {
    const { x, y, origin, cells, headerHeight } = options
    for (const cell of cells) {
        const left = origin.left + cell.x
        const top = origin.top + cell.y
        if (x < left || x > left + cell.w || y < top || y > top + cell.h) {
            continue
        }
        const bodyY = top + headerHeight
        const bodyH = Math.max(cell.h - headerHeight, 1)
        if (y < bodyY) {
            // The pane header chip strip: handled separately by headerHitAt
            // (reorder within the same pane / merge into a different pane),
            // so the body hit-test deliberately ignores it here.
            continue
        }
        const rect = { left, top: bodyY, width: cell.w, height: bodyH }
        if (y < bodyY + Math.min(headerHeight, bodyH)) {
            return { pane: cell.pane, side: 'all', rect }                       // upper body band — merge (full-area highlight)
        }
        if (x >= left && x <= left + cell.w * 0.25) { return { pane: cell.pane, side: 'l', rect } }
        if (x >= left + cell.w * 0.75 && x <= left + cell.w) { return { pane: cell.pane, side: 'r', rect } }
        if (y <= bodyY + bodyH * 0.5) { return { pane: cell.pane, side: 't', rect } }
        return { pane: cell.pane, side: 'b', rect }
    }
    return null
}

/**
 * Hit-test the pane HEADER (tab) strips. Returns the pane whose header
 * contains the point, the target insertion index (derived from the live
 * `.pane-tab` DOM positions), the client x of the insertion boundary, and the
 * header/body rects. Null when the point is not over any header strip.
 */
export function headerHitAt (options: HitTestOptions & { host: HTMLElement }): HeaderHit|null {
    const { x, y, origin, cells, headerHeight, host } = options
    const headers = host.querySelectorAll('.pane-header')
    for (let i = 0; i < cells.length; i++) {
        const cell = cells[i]
        const left = origin.left + cell.x
        const top = origin.top + cell.y
        if (x < left || x > left + cell.w || y < top || y > top + headerHeight) {
            continue
        }
        // Found the pane whose header strip contains the point. Resolve the
        // insertion index from the live tab DOM positions in that header.
        const headerEl = headers[i] as HTMLElement | undefined
        const headerRect = { left, top, width: cell.w, height: headerHeight }
        const bodyY = top + headerHeight
        const bodyH = Math.max(cell.h - headerHeight, 1)
        const bodyRect = { left, top: bodyY, width: cell.w, height: bodyH }
        const tabEls = headerEl?.querySelectorAll('.pane-tab') ?? []
        let targetIndex = cell.pane.tabs.length
        let lineX = left + cell.w
        for (let j = 0; j < tabEls.length; j++) {
            const r = (tabEls[j] as HTMLElement).getBoundingClientRect()
            if (x < r.left + r.width / 2) {
                targetIndex = j
                lineX = r.left
                break
            }
            lineX = r.right
        }
        return { pane: cell.pane, targetIndex, lineX, headerRect, bodyRect }
    }
    return null
}
