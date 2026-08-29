import { BaseTabComponent, GetRecoveryTokenOptions } from './baseTab.component'
import { SessionTab } from '../api/session'
import { RecoveryToken } from '../api/tabRecovery'
import { TabRecoveryService } from '../services/tabRecovery.service'

export type SplitOrientation = 'v' | 'h'
export type SplitDirection = 'r' | 't' | 'b' | 'l'

/**
 * Actual pixel thickness of the draggable gutter between two panes.
 * Layout subtracts (n-1)*band from the usable axis, like golden-layout's borderWidth.
 */
export const SPLITTER_BAND = 7

/**
 * Minimum pixel size of any pane along the split axis (golden-layout's defaultMinItem*).
 */
export const PANE_MIN_SIZE = 72

/**
 * Minimum pixel size of a leaf pane along the given axis. Containers add up their
 * children (same axis) or take the max (cross axis), mirroring golden-layout's
 * `calculateContentItemsTotalMinSize` behaviour.
 */
export function minSizeOf (child: TabView|null, axis: 'w'|'h'): number {
    if (!child) { return 0 }
    if (!(child instanceof SplitContainer)) { return PANE_MIN_SIZE }
    const childrenAxis: 'w'|'h' = child.orientation === 'v' ? 'h' : 'w'
    if (childrenAxis === axis) {
        return child.children.reduce((s, c) => s + minSizeOf(c, axis), 0)
    }
    return child.children.reduce((s, c) => Math.max(s, minSizeOf(c, axis)), 0)
}

export function clampValue (value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value))
}

/**
 * The container orientation a split direction resolves along: horizontal ('h')
 * for left/right splits, vertical ('v') for top/bottom.
 */
export function sideDirectionOf (side: SplitDirection): SplitOrientation {
    return ['l', 'r'].includes(side) ? 'h' : 'v'
}

/**
 * Finds the pane that hosts the given session in the given tree, or null.
 */
export function findPaneForTab (root: SplitContainer, tab: SessionTab): Pane|null {
    for (const child of root.children) {
        if (child instanceof SplitContainer) {
            const r = findPaneForTab(child, tab)
            if (r) { return r }
        } else if (child.tabs.includes(tab)) {
            return child
        }
    }
    return null
}

/**
 * Returns the immediate split container whose child (pane or sub-container)
 * contains `target`, or null when `target` is not in the tree.
 */
export function findParentContainer (root: SplitContainer, target: SessionTab | TabView): SplitContainer|null {
    for (const child of root.children) {
        if (child === target) { return root }
        if (child instanceof SplitContainer) {
            const r = findParentContainer(child, target)
            if (r) { return r }
        } else {
            if (target instanceof SessionTab && child.tabs.includes(target)) { return root }
        }
    }
    return null
}

/**
 * Inserts `pane` into `target` at `side` of the child hosting `relative`
 * (or the last child when `relative` is null). Pure tree mutation used by
 * [[WorkspaceComponent.addPane]].
 *
 * - Same orientation as `target`: split the relative pane in half so the
 *   absolute bar position of the other panes stays stable.
 * - Orientation mismatch: wrap the relative pane in a new container that takes
 *   half of its area.
 */
export function addPaneInto (target: SplitContainer, pane: Pane, relative: TabView|null, side: SplitDirection): void {
    const dir = sideDirectionOf(side)
    const before = ['l', 't'].includes(side)
    const relChild = relative ?? target.children[target.children.length - 1]
    const relIdx = target.children.indexOf(relChild)
    const relOther = target.children[relIdx]

    if (target.orientation === dir) {
        const insertAt = relIdx + (before ? 0 : 1)   // relative may be -1 if pane was removed
        const safeAt = insertAt < 0 ? target.children.length : insertAt
        const baseRatio = relIdx >= 0 ? target.ratios[relIdx] ?? 1 : 1
        if (relIdx >= 0) {
            target.ratios[relIdx] = baseRatio / 2
        } else {
            target.ratios.push(0)
        }
        target.children.splice(safeAt, 0, pane as any)
        target.ratios.splice(safeAt, 0, baseRatio / 2)
        return
    }

    const wrap = new SplitContainer()
    wrap.orientation = dir
    wrap.children = before ? [pane, relOther] : [relOther, pane]
    wrap.ratios = [1, 1]
    if (relIdx >= 0) {
        target.children[relIdx] = wrap
    } else {
        target.children.push(wrap)
        target.ratios.push(1)
    }
}

/**
 * Collects all leaf panes in tree order.
 */
export function collectPanes (root: SplitContainer): Pane[] {
    const result: Pane[] = []
    const walk = (node: SplitContainer): void => {
        for (const child of node.children) {
            if (child instanceof SplitContainer) { walk(child) } else { result.push(child) }
        }
    }
    walk(root)
    return result
}

/**
 * Prunes empty panes and collapses containers with a single effective child.
 * Deleted panes give their ratio weight to the next kept neighbour (falling
 * back to the previous one). Pure tree rewrite: returns null when nothing is
 * left, otherwise the collapsed/cleaned node.
 */
export function cleanNode (node: SplitContainer): TabView|null {
    const beforeChildren = node.children.slice()
    const beforeLen = beforeChildren.length
    const oldRatios = node.ratios.length === beforeLen
        ? node.ratios.slice()
        : beforeChildren.map(() => 1)

    const kept: TabView[] = []
    for (const child of beforeChildren) {
        if (child instanceof SplitContainer) {
            const cleaned = cleanNode(child)
            if (cleaned) { kept.push(cleaned) }
        } else if (child.tabs.length > 0) {
            kept.push(child)
        }
    }

    if (!kept.length) { return null }

    // Only one effective child left → hoist it up (its ratio weight is handled
    // by the parent).
    if (kept.length === 1) {
        return kept[0]
    }

    node.children = kept

    const keptOldIdx = kept.map(k => beforeChildren.indexOf(k))
    const changed = kept.length !== beforeLen

    if (changed) {
        // Deletion: give the removed pane's ratio weight to the next kept
        // neighbour (falling back to the previous one), keep the rest as-is.
        const newRatios = keptOldIdx.map(i => oldRatios[i] ?? 1)
        for (let d = 0; d < beforeLen; d++) {
            if (keptOldIdx.includes(d)) { continue }
            const after = keptOldIdx.findIndex(t => t > d)
            const prevArr = [...keptOldIdx].reverse()
            const prev = prevArr.findIndex(t => t < d)
            const absorb = after >= 0 ? after : prev >= 0 ? kept.length - 1 - prev : 0
            newRatios[absorb] += oldRatios[d] ?? 1
        }
        node.ratios = newRatios
    } else {
        // No deletion: keep the original ratios — never touch other regions.
        node.ratios = keptOldIdx.map(i => oldRatios[i] ?? 1)
    }
    return node
}

/**
 * Given a drop target (a [[Pane]] or a session), return the session right next
 * to which a new pane should be inserted — never the dragged session itself.
 */
export function resolveRelativeTab (ref: TabView|SessionTab|undefined, dragged: SessionTab): SessionTab|null {
    if (ref instanceof SplitContainer) {
        return ref.getAllTabs()[0] ?? null
    }
    if (ref instanceof Pane) {
        const first = ref.tabs[0]
        return first === dragged ? ref.tabs[1] ?? null : first
    }
    const t = ref!
    return t === dragged ? null : t
}

/**
 * A leaf pane. Unlike upstream (where each leaf is exactly one tab), a pane may
 * host several sub-tabs (sessions) like tabs in a browser window. Sessions only
 * ever live inside a workspace's panes — never at the top level.
 */
export class Pane {
    tabs: SessionTab[] = []
    activeTab: SessionTab|null = null

    constructor (tab: SessionTab|null = null) {
        if (tab) {
            this.tabs = [tab]
            this.activeTab = tab
        }
    }

    /**
     * @returns the session this pane should display right now, or null when the
     * pane is empty (a pane never stays empty after cleanup, but a mid-mutation
     * pane can briefly be).
     */
    get tab (): SessionTab|null {
        return this.tabs.length > 0 ? this.activeTab ?? this.tabs[0] : null
    }

    getAllTabs (): SessionTab[] {
        return this.tabs
    }
}

export type TabView = Pane | SplitContainer

/**
 * Represents a spanner (draggable border between two split areas)
 */
export interface SplitSpannerInfo {
    container: SplitContainer

    /**
     * Number of the right/bottom split in the container
     */
    index: number
}

/**
 * Represents the header strip drawn over the top of a multi-tab pane.
 */
export interface SplitTabPaneHeaderData {
    pane: Pane
    x: number
    y: number
    w: number
    h: number
}

/**
 * Describes a horizontal or vertical split row or column
 */
export class SplitContainer {
    private static uidCounter = 0

    /**
     * Stable per-instance identity, for Angular trackBy keys and any other
     * code that needs to tell containers apart across layout passes.
     */
    readonly uid = SplitContainer.uidCounter++

    orientation: SplitOrientation = 'h'

    /**
     * Children could be panes (multi-tab leaves) or other containers
     */
    children: (TabView)[] = []

    /**
     * Relative sizes of children, between 0 and 1. Total sum is 1
     */
    ratios: number[] = []

    x: number
    y: number
    w: number
    h: number

    /**
     * Pixel geometry of children from the last layout pass (px).
     * `pixelOffsets[i]` is the leading edge of child `i`, `pixelSizes[i]` its
     * content size. Refreshed by `WorkspaceComponent.layoutNode`, consumed by the
     * spanners so a drag can work purely in pixels like golden-layout.
     */
    pixelOffsets: number[] = []
    pixelSizes: number[] = []

    /** @returns the main axis pixel size of this container */
    get axisPx (): number {
        return this.orientation === 'v' ? this.h : this.w
    }

    /**
     * @return Flat list of all sessions inside this container
     */
    getAllTabs (): SessionTab[] {
        let r: SessionTab[] = []
        for (const child of this.children) {
            if (child instanceof SplitContainer) {
                r = r.concat(child.getAllTabs())
            } else {
                r = r.concat(child.tabs)
            }
        }
        return r
    }

    /**
     * Remove unnecessarily nested child containers and renormalizes [[ratios]]
     */
    normalize (): void {
        for (let i = 0; i < this.children.length; i++) {
            const child = this.children[i]

            if (child instanceof SplitContainer) {
                child.normalize()

                if (child.children.length === 0) {
                    this.children.splice(i, 1)
                    this.ratios.splice(i, 1)
                    i--
                    continue
                } else if (child.children.length === 1) {
                    this.children[i] = child.children[0]
                } else if (child.orientation === this.orientation) {
                    const ratio = this.ratios[i]
                    this.children.splice(i, 1)
                    this.ratios.splice(i, 1)
                    for (let j = 0; j < child.children.length; j++) {
                        this.children.splice(i, 0, child.children[j])
                        this.ratios.splice(i, 0, child.ratios[j] * ratio)
                        i++
                    }
                }
            }
        }

        let s = 0
        for (const x of this.ratios) {
            s += x
        }
        this.ratios = this.ratios.map(x => x / s)
    }

    /**
     * Makes all tabs have the same size
     */
    equalize (): void {
        for (const child of this.children) {
            if (child instanceof SplitContainer) {
                child.equalize()
            }
        }
        this.ratios.fill(1 / this.ratios.length)
    }

    /**
     * Gets the left/top side offset for the given element index (between 0 and 1)
     */
    getOffsetRatio (index: number): number {
        let s = 0
        for (let i = 0; i < index; i++) {
            s += this.ratios[i]
        }
        return s
    }

    async serialize (tabsRecovery: TabRecoveryService, options?: GetRecoveryTokenOptions): Promise<RecoveryToken> {
        const children: any[] = []
        for (const child of this.children) {
            if (child instanceof SplitContainer) {
                children.push(await child.serialize(tabsRecovery, options))
            } else {
                children.push({
                    type: 'app:split-tab-pane',
                    tabs: await Promise.all(child.tabs.map(tab => tabsRecovery.getFullRecoveryToken(tab, options))),
                    active: !child.tabs.includes(child.activeTab!) ? 0 : child.tabs.indexOf(child.activeTab!),
                })
            }
        }
        return {
            type: 'app:split-tab',
            ratios: this.ratios,
            orientation: this.orientation,
            children,
        }
    }
}

/**
 * A drop target on the workspace canvas: outer/relative edge bands and the
 * center of a pane cell. Produced by [[layoutTree]], consumed by the
 * `split-tab-drop-zone` component.
 */
export type SplitDropZoneInfo = {
    x: number
    y: number
    w: number
    h: number
} & ({
    type: 'relative'
    relativeTo?: TabView|BaseTabComponent
    side: SplitDirection
} | {
    type: 'center'
    pane: Pane
})

/**
 * The pixel rect a leaf pane occupies during this layout pass, plus the pane
 * itself so the caller can position the pane's tab DOM underneath the header.
 */
export interface PanePlacement {
    pane: Pane
    x: number
    y: number
    w: number
    h: number
}

/**
 * Everything the layout pass computes about the pane tree, as plain data.
 * [[WorkspaceComponent]] consumes this to (re)build its view-model arrays
 * (`_spanners` / `_dropZones` / `_paneHeaders`) and to style the tab DOM.
 */
export interface WorkspaceLayoutResult {
    placements: PanePlacement[]
    paneHeaders: SplitTabPaneHeaderData[]
    spanners: SplitSpannerInfo[]
    dropZones: SplitDropZoneInfo[]
}

/**
 * Pure pixel-accurate layout. Children take their share of `usable` = axis -
 * bands, floored individually with the remainder spread to the LAST child only
 * (golden-layout's `calculateAbsoluteSizes` additionalPixel), so there are
 * never pixel gaps and a dragged splitter always sits on the visible boundary.
 *
 * Writes geometry back into every container (`x/y/w/h`, `pixelSizes`,
 * `pixelOffsets`) and returns the derived pane placements plus the gutter /
 * drop-zone / header view data in the exact recursive order the DOM expects.
 *
 * @param recreate When false (mid pixel-resize drag) zonal/spanner/header data
 *   is omitted so the previous view arrays are left untouched; geometry and
 *   pane placements are still computed for DOM restyle.
 */
export function layoutTree (
    root: SplitContainer,
    x: number,
    y: number,
    w: number,
    h: number,
    paneHeaderHeight: number,
    recreate: boolean,
): WorkspaceLayoutResult {
    const placements: PanePlacement[] = []
    const paneHHeaders: SplitTabPaneHeaderData[] = []
    const spanners: SplitSpannerInfo[] = []
    const dropZones: SplitDropZoneInfo[] = []

    const walk = (node: SplitContainer, nx: number, ny: number, nw: number, nh: number): void => {
        const vertical = node.orientation === 'v'
        node.x = nx
        node.y = ny
        node.w = nw
        node.h = nh

        const axis = vertical ? nh : nw
        const n = node.children.length
        const bandTotal = n > 1 ? (n - 1) * SPLITTER_BAND : 0
        const usable = Math.max(axis - bandTotal, 0)

        const floor = node.ratios.map(ratio => Math.floor(ratio * usable))
        const used = floor.reduce((s, px) => s + px, 0)
        if (n) {
            const extra = Math.floor(usable) - used
            if (extra > 0) {
                floor[n - 1] += extra
            }
        }
        node.pixelSizes = floor.slice()

        node.pixelOffsets = []
        let off = 0
        for (let i = 0; i < n; i++) {
            node.pixelOffsets.push(off)
            off += node.pixelSizes[i] + (i < n - 1 ? SPLITTER_BAND : 0)
        }

        if (node === root && recreate) {
            dropZones.push({ x: nx - SPLITTER_BAND, y: ny, w: SPLITTER_BAND, h: nh, type: 'relative', side: 'l' })
            dropZones.push({ x: nx, y: ny - SPLITTER_BAND, w: nw, h: SPLITTER_BAND, type: 'relative', side: 't' })
            dropZones.push({ x: nx + nw, y: ny, w: SPLITTER_BAND, h: nh, type: 'relative', side: 'r' })
            dropZones.push({ x: nx, y: ny + nh, w: nw, h: SPLITTER_BAND, type: 'relative', side: 'b' })
        }

        node.children.forEach((child, i) => {
            const size = node.pixelSizes[i]
            const offset = node.pixelOffsets[i]
            const childX = vertical ? nx : nx + offset
            const childY = vertical ? ny + offset : ny
            const childW = vertical ? nw : size
            const childH = vertical ? size : nh

            if (child instanceof SplitContainer) {
                walk(child, childX, childY, childW, childH)
            } else {
                placements.push({ pane: child, x: childX, y: childY, w: childW, h: childH })
                if (recreate) {
                    paneHHeaders.push({ pane: child, x: childX, y: childY, w: childW, h: paneHeaderHeight })
                    dropZones.push({
                        type: 'center',
                        pane: child,
                        x: childX,
                        y: childY + paneHeaderHeight,
                        w: childW,
                        h: Math.max(childH - paneHeaderHeight, 0),
                    })
                }
            }

            if (recreate) {
                if (i !== n - 1) {
                    dropZones.push({
                        type: 'relative',
                        relativeTo: child,
                        side: vertical ? 'b' : 'r',
                        x: vertical ? nx : nx + node.pixelOffsets[i + 1] - SPLITTER_BAND,
                        y: vertical ? ny + node.pixelOffsets[i + 1] - SPLITTER_BAND : ny,
                        w: vertical ? nw : SPLITTER_BAND,
                        h: vertical ? SPLITTER_BAND : nh,
                    })
                }

                if (vertical) {
                    dropZones.push({ x: nx, y: ny + offset, w: SPLITTER_BAND, h: size, type: 'relative', relativeTo: child, side: 'l' })
                    dropZones.push({ x: nx + nw - SPLITTER_BAND, y: ny + offset, w: SPLITTER_BAND, h: size, type: 'relative', relativeTo: child, side: 'r' })
                } else {
                    dropZones.push({ x: nx + offset, y: ny, w: size, h: SPLITTER_BAND, type: 'relative', relativeTo: child, side: 't' })
                    dropZones.push({ x: nx + offset, y: ny + nh - SPLITTER_BAND, w: size, h: SPLITTER_BAND, type: 'relative', relativeTo: child, side: 'b' })
                }

                if (i !== 0) {
                    spanners.push({ container: node, index: i })
                }
            }
        })
    }

    walk(root, x, y, w, h)
    return { placements, paneHeaders: paneHHeaders, spanners, dropZones }
}
