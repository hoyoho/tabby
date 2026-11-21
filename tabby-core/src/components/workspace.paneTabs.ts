/**
 * DOM measurement helpers for the pane-tab chip strip. Kept outside the
 * workspace component because they only read/write element geometry and
 * classes, and the marquee rules are easier to reason about in isolation.
 */

/** The title element of a pane-tab chip. */
export function paneTabLabelOf (tab: HTMLElement): HTMLElement|null {
    return tab.querySelector(':scope > .pane-tab-label')
}

/**
 * How many pixels of a pane-tab's title the chip hides, 0 when it fits —
 * measured independently of what the chip is currently showing.
 *
 * The label's `scrollWidth` is the title's natural width in either layout
 * (clipped to the chip when idle, max-content while marqueeing), and the
 * window it is given comes from the chip's own box minus whatever its other
 * children (the admin badge) take. Reading `label.clientWidth` instead would
 * report no overflow for a chip whose marquee is already running — which is
 * exactly the case a title change during a hover arrives in.
 */
export function paneTabTitleOverflow (tab: HTMLElement, label: HTMLElement): number {
    // Computed lengths are strings, and `auto` (a valid margin) has no numeric
    // value: NaN here would poison the custom property feeding the keyframes.
    const px = (value: string): number => parseFloat(value) || 0
    const chipStyle = getComputedStyle(tab)
    let available = tab.clientWidth - px(chipStyle.paddingLeft) - px(chipStyle.paddingRight)
    for (const child of Array.from(tab.children)) {
        if (child === label) { continue }
        const childStyle = getComputedStyle(child)
        available -= child.getBoundingClientRect().width + px(childStyle.marginLeft) + px(childStyle.marginRight)
    }
    return Math.max(label.scrollWidth - available, 0)
}

/**
 * Start, re-aim or stop a pane-tab marquee for a measured overflow. The
 * measurement is passed in instead of being re-taken so the scroll always
 * covers exactly what the `overflowing` class reports as hidden.
 */
export function applyPaneTabMarquee (tab: HTMLElement, overflow: number): void {
    if (overflow <= 0) {
        tab.classList.remove('marquee')
        return
    }
    // The keyframes own the motion; this only feeds them the distance and a
    // pace proportional to it, clamped so short overflows don't fly past and
    // long ones don't crawl.
    const duration = Math.min(Math.max(overflow * 0.025, 1.5), 6)
    tab.style.setProperty('--marquee-distance', `-${overflow}px`)
    tab.style.setProperty('--marquee-duration', `${duration}s`)
    tab.classList.add('marquee')
}

/**
 * Re-evaluates every pane-tab label's overflow: toggles the persistent
 * `overflowing` class so long titles are left-aligned, and keeps a marquee
 * that is already running aimed at the title that is on screen (a session
 * that re-titles itself mid-hover, or a chip whose final width has just been
 * reached). Both consumers take their numbers from the same measurement, so
 * they cannot disagree about how much is hidden.
 */
export function refreshPaneTabOverflowStates (host: HTMLElement): void {
    const tabs = Array.from(host.querySelectorAll('.pane-tab')) as HTMLElement[]
    for (const tab of tabs) {
        const label = paneTabLabelOf(tab)
        if (!label) { continue }
        const overflow = paneTabTitleOverflow(tab, label)
        tab.classList.toggle('overflowing', overflow > 0)
        if (tab.classList.contains('marquee')) {
            applyPaneTabMarquee(tab, overflow)
        }
    }
}
