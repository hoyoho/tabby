import { SessionTab } from '../api/session'
import { Pane, SplitContainer, SplitDirection, SplitOrientation, TabView, clampValue, minSizeOf, collectPanes } from './workspace.layout'

/**
 * The narrow slice of [[WorkspaceComponent]] keyboard/split navigation needs.
 * Dictates geometry via refs/root/focus/layout so the navigation logic can
 * live outside the component.
 */
export interface PaneNavigationHost {
    readonly root: SplitContainer
    readonly focusedTab: SessionTab|null
    /** `config.store.terminal.paneResizeStep` (0.1 default) */
    readonly paneResizeStep: number

    /** DOM node of a session (its rendered pane cell), or undefined. */
    elementFor: (tab: SessionTab) => HTMLElement|undefined
    getPaneOf: (tab: SessionTab) => Pane|null
    getParentOf: (target: SessionTab | TabView) => SplitContainer|null
    focus: (tab: SessionTab) => void
    getAllTabs: () => SessionTab[]
    layout: () => void
}

/**
 * Pane/session keyboard navigation and splitter-step moves. Consumes the
 * workspace purely through [[PaneNavigationHost]].
 */
export class PaneNavigation {
    constructor (private host: PaneNavigationHost) {}

    navigate (dir: SplitDirection): void {
        if (this.host.focusedTab) { this.host.focus(this.nearestPaneInDirection(this.host.focusedTab, dir)) }
    }

    navigateLinear (delta: number): void {
        const focused = this.host.focusedTab
        if (!focused) { return }
        const all = this.host.getAllTabs()
        const target = all[(all.indexOf(focused) + delta + all.length) % all.length]
        this.host.focus(target)
    }

    navigateSpecific (target: number): void {
        const panes = this.paneRepresentatives()
        if (target < panes.length) { this.host.focus(panes[target]) }
    }

    /**
     * Moves one of the four splitters adjacent to the focused pane by one step
     * (paneResizeStep fraction of the axis). `side` is the splitter relative to
     * the focused pane; `delta` is the pixel-direction the splitter travels.
     */
    moveSplitter (side: 'up'|'down'|'left'|'right', delta: number): void {
        if (!this.host.focusedTab) { return }
        const axis: 'w'|'h' = side === 'left' || side === 'right' ? 'w' : 'h'
        const orient: SplitOrientation = axis === 'w' ? 'h' : 'v'
        const siblingBefore = side === 'up' || side === 'left'

        let view: TabView|null = this.host.getPaneOf(this.host.focusedTab) ?? this.host.focusedTab as any
        while (view) {
            const parent = this.host.getParentOf(view)
            if (!parent) { return }
            const idx = parent.children.indexOf(view)
            if (idx < 0) { return }
            if (parent.orientation === orient) {
                const siblingOnSide = siblingBefore ? idx > 0 : idx < parent.children.length - 1
                if (siblingOnSide) {
                    const sibIdx = siblingBefore ? idx - 1 : idx + 1
                    this.tradeSplitterSizes(parent, idx, sibIdx, axis, delta)
                    return
                }
            }
            view = parent
        }
    }

    private tradeSplitterSizes (container: SplitContainer, idx: number, sibIdx: number, axis: 'w'|'h', delta: number): void {
        const totalPx = container.axisPx
        if (totalPx <= 0) { return }
        const myMin = minSizeOf(container.children[idx], axis)
        const sibMin = minSizeOf(container.children[sibIdx], axis)
        const stepPx = Math.max(25, totalPx * this.host.paneResizeStep)
        const myPx = container.ratios[idx] * totalPx
        const newPx = clampValue(myPx + delta * stepPx, Math.max(myMin, 0), Math.max(myMin, totalPx - sibMin))
        if (Math.abs(newPx - myPx) < 1) { return }

        const prevMy = container.ratios[idx]
        const prevSib = container.ratios[sibIdx]
        container.ratios[idx] = newPx / totalPx
        container.ratios[sibIdx] = container.ratios[sibIdx] - (newPx - myPx) / totalPx
        this.host.layout()

        // Sanity: never let a participant shrink below its minimum — that is
        // what could let a pane (and its title bar) collapse into its neighbour
        // and get stuck. Revert if the layout produced an undersized cell.
        const finalSizes = container.pixelSizes
        const belowMin = finalSizes[idx] < minSizeOf(container.children[idx], axis) ||
            finalSizes[sibIdx] < minSizeOf(container.children[sibIdx], axis)
        if (belowMin) {
            container.ratios[idx] = prevMy
            container.ratios[sibIdx] = prevSib
            this.host.layout()
        }
    }

    nearestPaneInDirection (from: SessionTab, direction: SplitDirection): SessionTab {
        // Exclude the pane hosting `from` up front: with a multi-session pane
        // the pane representative may be a different tab than `from`, so the
        // identity check below can't be the only guard.
        const fromPane = this.host.getPaneOf(from)
        const rect = this.paneRect(from)
        const panes = this.paneRepresentatives()
            .filter(tab => tab !== from && this.host.getPaneOf(tab) !== fromPane)
            .map(tab => ({ tab, rect: this.paneRect(tab) }))
        let candidates = panes
        if (direction === 'l') { candidates = panes.filter(p => p.rect.right <= rect.left) } else if (direction === 'r') { candidates = panes.filter(p => p.rect.left >= rect.right) } else if (direction === 't') { candidates = panes.filter(p => p.rect.bottom <= rect.top) } else { candidates = panes.filter(p => p.rect.top >= rect.bottom) }

        let nearest: SessionTab|null = null
        let nearestDistance = Infinity
        for (const candidate of candidates) {
            const distance = Math.abs(rect.left + rect.width / 2 - candidate.rect.left - candidate.rect.width / 2) +
                Math.abs(rect.top + rect.height / 2 - candidate.rect.top - candidate.rect.height / 2)
            if (distance < nearestDistance) {
                nearest = candidate.tab
                nearestDistance = distance
            }
        }
        return nearest ?? from
    }

    /**
     * One representative session per pane (its active one). Directional pane
     * navigation and linear/specific jumps use these so multi-session panes
     * behave like a single focused cell while enumeration stays session-based.
     */
    private paneRepresentatives (): SessionTab[] {
        return collectPanes(this.host.root)
            .map(pane => pane.tab)
            .filter((tab): tab is SessionTab => tab != null)
    }

    private paneRect (pane: SessionTab): DOMRect {
        const element = this.host.elementFor(pane)
        if (!element) { return new DOMRect() }
        return element.getBoundingClientRect()
    }
}
