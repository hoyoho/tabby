import { Component, Input, HostBinding, HostListener, ChangeDetectorRef } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import { ConfigService } from '../services/config.service'
import { SidebarService } from '../services/sidebar.service'
import { SidebarContribution } from '../api/sidebarContribution'

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
export class AppSidebarComponent {
    /** Mirrors the macOS traffic-light inset that the profile tree expects. */
    @Input() macInset = false

    // Below this released width the built-in profile panel closes entirely;
    // between here and its minWidth it snaps back (avoids accidental close).
    panelCollapseThreshold = 30

    isResizing = false
    private resizingPanel: SidebarPanelRef|null = null
    private startX = 0
    private startWidth = 0

    /** Per-panel width cache, hydrated from localStorage on first use. */
    private widthCache = new Map<string, number>()

    activePanelId: string = window.localStorage.sidebarActivePanel ?? PROFILES_PANEL_ID

    constructor (
        public config: ConfigService,
        public sidebar: SidebarService,
        private translate: TranslateService,
        private cdr: ChangeDetectorRef,
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
        return panels.find(p => p.id === this.activePanelId) ?? panels[0] ?? null
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
        this.isResizing = true
        this.resizingPanel = this.activePanel
        this.startX = event.clientX
        this.startWidth = this.widthOf(this.activePanel)
        event.preventDefault()
    }

    @HostListener('document:mousemove', ['$event'])
    onMouseMove (event: MouseEvent): void {
        if (!this.isResizing || !this.resizingPanel) {
            return
        }
        const delta = event.clientX - this.startX
        // The width tracks the mouse continuously (0..max); the close/min
        // decision is deferred to mouseup so the handle never teleports under
        // the cursor.
        const width = Math.max(0, Math.min(this.maxWidthOf(this.resizingPanel), this.startWidth + delta))
        this.widthCache.set(this.resizingPanel.id, width)
        this.cdr.markForCheck()
    }

    @HostListener('document:mouseup')
    stopResize (): boolean {
        const panel = this.resizingPanel
        this.isResizing = false
        this.resizingPanel = null
        if (!panel) {
            return true
        }

        const width = this.widthOf(panel)
        if (panel.id === PROFILES_PANEL_ID && width < this.panelCollapseThreshold) {
            // Released near the left edge: close the built-in profile panel
            // entirely, it can be re-enabled from the settings or the hotkey.
            // Keep a usable width so re-opening does not bring back a 0px panel.
            this.widthCache.set(panel.id, panel.minWidth)
            window.localStorage[`sidebarWidth:${panel.id}`] = panel.minWidth
            this.config.store.showProfileTree = false
            this.config.save()
        } else {
            const clamped = Math.min(this.maxWidthOf(panel), Math.max(panel.minWidth, width))
            this.widthCache.set(panel.id, clamped)
            window.localStorage[`sidebarWidth:${panel.id}`] = clamped
        }
        this.cdr.markForCheck()
        return true
    }

    private widthOf (panel: SidebarPanelRef): number {
        if (this.widthCache.has(panel.id)) {
            return this.widthCache.get(panel.id)!
        }
        let width: number
        if (panel.id === PROFILES_PANEL_ID) {
            // Migrate the pre-per-panel keys for the built-in tree.
            width = parseInt(window.localStorage.sidebarWidth ?? window.localStorage.profileTreeWidth ?? String(panel.defaultWidth))
        } else {
            const stored = window.localStorage[`sidebarWidth:${panel.id}`]
            width = stored != null ? parseInt(stored) : panel.defaultWidth
        }
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
