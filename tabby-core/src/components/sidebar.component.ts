import { Component, ElementRef, Input, HostBinding, HostListener, ChangeDetectorRef, OnDestroy } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import { ConfigService } from '../services/config.service'
import { SidebarService } from '../services/sidebar.service'
import { SidebarContribution } from '../api/sidebarContribution'

/** Must match $resize-transition-duration in sidebar.component.scss. */
const RESIZE_ANIMATION_MS = 125

/** Metadata for one entry of the built-in platform's panel switcher. */
export interface SidebarPanelRef {
    id: string
    title: string
    icon: string
    order: number
    minWidth: number
    defaultWidth: number
    maxWidth: number
}

export const PROFILES_PANEL_ID = 'profiles'

/**
 * Host for the application sidebar.
 *
 * When a plugin registers an `owner` contribution the host renders it instead
 * of the built-in platform, giving the plugin the whole area (it manages its
 * own width and layout). Otherwise the built-in platform is shown: the profile
 * tree plus any `panel`/`widget` contributions. The host owns the width and
 * remembers it per panel, so each panel can have its own comfortable size and
 * switching does not leave a panel cramped or stretched.
 */
@Component({
    selector: 'app-sidebar',
    templateUrl: './sidebar.component.pug',
    styleUrls: ['./sidebar.component.scss'],
})
export class AppSidebarComponent implements OnDestroy {
    /** Mirrors the macOS traffic-light inset that the profile tree expects. */
    @Input() macInset = false

    // Below this released width the built-in profile panel closes entirely;
    // between here and its minWidth it snaps back (avoids accidental close).
    panelCollapseThreshold = 30

    isResizing = false
    private resizingPanel: SidebarPanelRef|null = null
    private startX = 0
    private startWidth = 0
    /**
     * Live drag distance, applied to the sash as a transform while the sidebar
     * width stays put. Committing the width on every move would reflow the
     * terminal underneath; instead we only move the handle and commit once on
     * release.
     */
    private dragOffset = 0
    /** Body cursor to restore when the drag ends or the component is destroyed. */
    private previousBodyCursor = ''

    /** Set while the released width animates to its committed value. */
    committing = false
    /** Screen position of the fixed clone shown during that animation. */
    commitX: number|null = null
    commitTop = 0
    commitHeight = 0
    private commitTimer: ReturnType<typeof setTimeout>|null = null

    /** Per-panel width cache, hydrated from localStorage on first use. */
    private widthCache = new Map<string, number>()

    activePanelId: string = window.localStorage.sidebarActivePanel ?? PROFILES_PANEL_ID

    constructor (
        public config: ConfigService,
        public sidebar: SidebarService,
        private translate: TranslateService,
        private cdr: ChangeDetectorRef,
        private element: ElementRef<HTMLElement>,
    ) { }

    get owner (): SidebarContribution|null {
        return this.sidebar.owner
    }

    get ownerType (): any {
        return this.owner?.getComponentType() ?? null
    }

    get widgets (): SidebarContribution[] {
        return this.sidebar.widgets
    }

    /** Built-in `profiles` panel first, then plugin panels, ordered by weight. */
    get panels (): SidebarPanelRef[] {
        const panels: SidebarPanelRef[] = []
        if (this.config.store.showProfileTree) {
            panels.push({
                id: PROFILES_PANEL_ID,
                title: this.translate.instant('Profiles'),
                icon: 'fas fa-list',
                order: 0,
                minWidth: 200,
                defaultWidth: 300,
                maxWidth: 600,
            })
        }
        for (const panel of this.sidebar.panels) {
            panels.push({
                id: panel.id,
                title: panel.title,
                icon: panel.icon,
                order: panel.order,
                minWidth: panel.minWidth,
                defaultWidth: panel.defaultWidth,
                maxWidth: panel.maxWidth,
            })
        }
        return panels.sort((a, b) => a.order - b.order)
    }

    /** The panel to render, falling back to the first when the stored one is gone. */
    get activePanel (): SidebarPanelRef|null {
        const panels = this.panels
        return panels.find(p => p.id === this.activePanelId) ?? (panels.length > 0 ? panels[0] : null)
    }

    /**
     * Whether the sidebar area is shown at all. `showProfileTree` is the
     * historic key, but it gates the whole area now: an `owner` contribution
     * is hidden by the same toggle (settings switch and hotkey), which would
     * otherwise keep a plugin's sidebar on screen when the user asked for the
     * sidebar to go away.
     */
    get sidebarVisible (): boolean {
        return this.config.store.showProfileTree
    }

    get baseVisible (): boolean {
        return this.sidebarVisible && !this.owner && this.activePanel != null
    }

    @HostBinding('style.width.px')
    get hostWidth (): number|null {
        // An owner contribution sizes itself; only the built-in platform uses
        // the host-managed, per-panel width.
        if (!this.baseVisible || !this.activePanel) {
            return null
        }
        return this.widthOf(this.activePanel)
    }

    @HostBinding('class.resizing')
    get hostResizing (): boolean {
        return this.isResizing
    }

    /** Sash translation during a drag; null at rest so no transform lingers. */
    get sashTransform (): string|null {
        return this.dragOffset === 0 ? null : `translateX(${this.dragOffset}px)`
    }

    selectPanel (panel: SidebarPanelRef): void {
        this.activePanelId = panel.id
        window.localStorage.sidebarActivePanel = panel.id
    }

    trackPanel (_: number, panel: SidebarPanelRef): string {
        return panel.id
    }

    trackContribution (_: number, contribution: SidebarContribution): string {
        return contribution.id
    }

    startResize (event: MouseEvent): void {
        if (!this.activePanel) {
            return
        }
        this.cancelCommitAnimation()
        if (!this.isResizing) {
            this.previousBodyCursor = document.body.style.cursor
        }
        this.isResizing = true
        this.resizingPanel = this.activePanel
        this.startX = event.clientX
        this.startWidth = this.widthOf(this.activePanel)
        this.dragOffset = 0
        document.body.style.cursor = 'ew-resize'
        event.preventDefault()
    }

    @HostListener('document:mousemove', ['$event'])
    onMouseMove (event: MouseEvent): void {
        if (!this.isResizing || !this.resizingPanel) {
            return
        }
        const delta = event.clientX - this.startX
        // Track the clamped width as a sash offset only. The sidebar keeps its
        // committed width during the drag, so the terminal is never asked to
        // reflow on every frame; the close/min decision is deferred to release.
        const width = Math.max(0, Math.min(this.maxWidthOf(this.resizingPanel), this.startWidth + delta))
        this.dragOffset = width - this.startWidth
        this.cdr.markForCheck()
    }

    @HostListener('document:mouseup')
    stopResize (): boolean {
        const panel = this.resizingPanel
        if (!this.isResizing || !panel) {
            return true
        }
        // Capture the current edge before the committed width changes; the
        // fixed bar clone is placed at the final edge and the host width
        // animates there underneath it.
        const rect = this.element.nativeElement.getBoundingClientRect()
        const startWidth = this.startWidth
        const width = this.startWidth + this.dragOffset
        this.resetDragState()

        let finalWidth = panel.minWidth
        let collapsed = false
        if (panel.id === PROFILES_PANEL_ID && width < this.panelCollapseThreshold) {
            // Released near the left edge: close the built-in profile panel
            // entirely, it can be re-enabled from the settings or the hotkey.
            // Keep a usable width so re-opening does not bring back a 0px panel.
            finalWidth = panel.minWidth
            this.widthCache.set(panel.id, finalWidth)
            window.localStorage[`sidebarWidth:${panel.id}`] = finalWidth
            this.config.store.showProfileTree = false
            this.config.save()
            collapsed = true
        } else {
            finalWidth = Math.min(this.maxWidthOf(panel), Math.max(panel.minWidth, width))
            this.widthCache.set(panel.id, finalWidth)
            window.localStorage[`sidebarWidth:${panel.id}`] = finalWidth
        }
        this.cdr.markForCheck()
        if (!collapsed) {
            this.startCommitAnimation(rect, rect.right + (finalWidth - startWidth))
        }
        return true
    }

    private startCommitAnimation (rect: DOMRect, edge: number): void {
        this.cancelCommitAnimation()
        this.committing = true
        // The sash is the last 4px of the host, so its left edge is the final
        // edge minus its width.
        this.commitX = edge - 4
        this.commitTop = rect.top
        this.commitHeight = rect.height
        this.commitTimer = setTimeout(() => {
            this.commitTimer = null
            this.committing = false
        }, RESIZE_ANIMATION_MS)
    }

    private cancelCommitAnimation (): void {
        if (this.commitTimer) {
            clearTimeout(this.commitTimer)
            this.commitTimer = null
        }
        this.committing = false
    }

    /**
     * Fallback for a drag that ends outside the window: commit the current
     * offset instead of leaving the sidebar stuck in resize mode with the
     * ew-resize cursor applied.
     */
    @HostListener('document:mouseleave')
    @HostListener('window:blur')
    abortResize (): void {
        if (this.isResizing) {
            this.stopResize()
        }
    }

    ngOnDestroy (): void {
        // Do not leave the global resize cursor behind if the host disappears
        // in the middle of a drag.
        if (this.isResizing) {
            this.resetDragState()
        }
        this.cancelCommitAnimation()
    }

    /** Clears drag state and restores the body cursor without committing width. */
    private resetDragState (): void {
        this.isResizing = false
        this.resizingPanel = null
        this.dragOffset = 0
        document.body.style.cursor = this.previousBodyCursor
    }

    private widthOf (panel: SidebarPanelRef): number {
        if (this.widthCache.has(panel.id)) {
            return this.widthCache.get(panel.id)!
        }
        // Migrate the pre-per-panel keys for the built-in tree.
        const rawStored = panel.id === PROFILES_PANEL_ID
            ? window.localStorage.sidebarWidth ?? window.localStorage.profileTreeWidth ?? String(panel.defaultWidth)
            : window.localStorage[`sidebarWidth:${panel.id}`] ?? String(panel.defaultWidth)
        const width = parseInt(rawStored)
        this.widthCache.set(panel.id, width)
        return width
    }

    private maxWidthOf (panel: SidebarPanelRef): number {
        if (panel.maxWidth > 0) {
            return panel.maxWidth
        }
        // No specific maximum: let the panel grow, but keep a sliver of the
        // session area visible.
        return Math.max(panel.minWidth, window.innerWidth - 200)
    }
}
