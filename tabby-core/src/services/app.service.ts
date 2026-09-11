import { Injectable, Inject } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { Observable, Subject, AsyncSubject, Subscription, takeUntil, debounceTime } from 'rxjs'

import { BaseTabComponent } from '../components/baseTab.component'
import { WorkspaceComponent } from '../components/workspace.component'
import { RenameTabModalComponent } from '../components/renameTabModal.component'
import { SessionTab } from '../api/session'
import { TopLevelTab } from '../api/topLevelTab'
import { SelectorOption } from '../api/selector'
import { RecoveryToken } from '../api/tabRecovery'
import { BootstrapData, BOOTSTRAP_DATA } from '../api/mainProcess'
import { HostWindowService } from '../api/hostWindow'
import { HostAppService } from '../api/hostApp'

import { ConfigService } from './config.service'
import { TabRecoveryService } from './tabRecovery.service'
import { TabsService, NewTabParameters } from './tabs.service'
import { SelectorService } from './selector.service'
import { TABBY_DRAG_MIME, TABBY_WORKSPACE_DRAG_MIME, NativeDragPayload, WorkspaceDragPayload, isWorkspaceDraggedOver, setupWorkspaceDraggedOverTracking, dragLeftDocument } from '../components/workspace.dragDrop'

class CompletionObserver {
    get done$ (): Observable<void> { return this.done }
    get destroyed$ (): Observable<void> { return this.destroyed }
    private done = new AsyncSubject<void>()
    private destroyed = new AsyncSubject<void>()
    private interval: number

    constructor (private tab: BaseTabComponent) {
        this.interval = setInterval(() => this.tick(), 1000) as any
        this.tab.destroyed$.pipe(takeUntil(this.destroyed$)).subscribe(() => this.stop())
    }

    async tick () {
        if (!await this.tab.getCurrentProcess()) {
            this.done.next()
            this.stop()
        }
    }

    stop () {
        clearInterval(this.interval)
        this.destroyed.next()
        this.destroyed.complete()
        this.done.complete()
    }
}

@Injectable({ providedIn: 'root' })
export class AppService {
    tabs: TopLevelTab[] = []

    get activeTab (): TopLevelTab|null { return this._activeTab ?? null }

    private lastTabIndex = 0
    private _activeTab: TopLevelTab | null = null
    private closedTabsStack: RecoveryToken[] = []

    /** The workspace whose tab header is currently hovered by a workspace drag. */
    private wsInsertionMarker: HTMLDivElement|null = null
    /**
     * Source side of a native workspace-tab drag (this window has the tab
     * being dragged). Non-null only while a drag is pending resolution.
     */
    private workspaceNativeDrag: { dragId: string, tab: WorkspaceComponent, committedSub: Subscription, settled: boolean, acceptTimer: number|null }|null = null
    // dragIds of native drags this window started, kept briefly. A very late
    // `drop` of our own drag (missed earlier, or re-dispatched after the
    // source already settled it) must never re-create the dragged item in
    // this window via the cross-window restore path.
    private selfDragIds: string[] = []

    /** Registers a drag id as originating from THIS window (workspace tabs
      * and pane sessions alike) so a late/re-dispatched drop of it can never
      * take the cross-window restore path here. */
    registerOwnDrag (dragId: string): void {
        this.selfDragIds.push(dragId)
        if (this.selfDragIds.length > 8) {
            this.selfDragIds.shift()
        }
    }

    /** Whether the drag id was started in this window (see [[registerOwnDrag]]). */
    isOwnDrag (dragId: string): boolean {
        return this.selfDragIds.includes(dragId)
    }

    private activeTabChange = new Subject<BaseTabComponent|null>()
    private tabsChanged = new Subject<void>()
    private tabOpened = new Subject<BaseTabComponent>()
    private tabRemoved = new Subject<BaseTabComponent>()
    private tabClosed = new Subject<BaseTabComponent>()
    private tabDragActive = new Subject<BaseTabComponent|null>()
    private ready = new AsyncSubject<void>()
    private recoveryStateChangedHint = new Subject<void>()

    private completionObservers = new Map<BaseTabComponent, CompletionObserver>()

    get activeTabChange$ (): Observable<BaseTabComponent|null> { return this.activeTabChange }
    get tabOpened$ (): Observable<BaseTabComponent> { return this.tabOpened }
    get tabsChanged$ (): Observable<void> { return this.tabsChanged }
    get tabRemoved$ (): Observable<BaseTabComponent> { return this.tabRemoved }
    get tabClosed$ (): Observable<BaseTabComponent> { return this.tabClosed }
    get tabDragActive$ (): Observable<BaseTabComponent|null> { return this.tabDragActive }

    /** Fires once when the app is ready */
    get ready$ (): Observable<void> { return this.ready }

    /** @hidden */
    private constructor (
        private config: ConfigService,
        private hostApp: HostAppService,
        private hostWindow: HostWindowService,
        private tabRecovery: TabRecoveryService,
        private tabsService: TabsService,
        private selector: SelectorService,
        private ngbModal: NgbModal,
        @Inject(BOOTSTRAP_DATA) private bootstrapData: BootstrapData,
    ) {
        this.tabsChanged$.subscribe(() => {
            this.recoveryStateChangedHint.next()
        })

        setInterval(() => {
            this.recoveryStateChangedHint.next()
        }, 30000)

        this.recoveryStateChangedHint.pipe(debounceTime(1000)).subscribe(() => {
            this.tabRecovery.saveTabs(this.tabs)
        })

        config.ready$.toPromise().then(async () => {
            if (this.bootstrapData.isMainWindow) {
                const recoverWorkspaces = config.store.workspace?.recoverTabs
                if (recoverWorkspaces) {
                    const tabs = await this.tabRecovery.recoverTabs()
                    for (const tab of tabs) {
                        this.openNewTabRaw(tab)
                    }
                }
                /** Continue to store the tabs even if the setting is currently off */
                this.tabRecovery.enabled = true
            }
        })

        // A workspace dragged out of another window arrives as a recovery
        // token; rebuild it here (any window can receive one).
        this.hostApp.openRecoveryToken$.subscribe(async token => {
            const params = await this.tabRecovery.recoverTab(token)
            if (params) {
                this.openNewTabRaw(params as any)
            }
        })

        // Receiving side for native workspace-tab drags (system DnD, like pane
        // sessions): any window accepts, and a drop re-homes the workspace as a
        // TOP-LEVEL tab there — same window reorders, another window rebuilds it
        // from the out-of-band recovery token. It is never merged INTO another
        // workspace; the tab bar previews the drop as an insertion divider.
        this.setupWorkspaceNativeDrop()

        // Per-window half of the global "dragged over" tracker (vscode dnd.ts
        // parity): dragend consults it to tell a drop that landed in one of
        // our windows apart from one a foreign app swallowed.
        setupWorkspaceDraggedOverTracking()

        this.tabClosed$.subscribe(() => {
            if (!this.tabs.length && this.config.store.appearance.lastTabClosesWindow) {
                this.hostWindow.close()
            }
        })

        hostWindow.windowFocused$.subscribe(() => this._activeTab?.emitFocused())

        // Single per-window ROUTER for native (HTML5/system DnD) session drops.
        // Every mounted workspace used to listen for drops on the document and
        // disambiguate at runtime — a drop re-dispatched after the source's
        // selectTab flipped the active workspace then slipped into the
        // cross-window restore path and duplicated the session onto the same
        // PTY. Ownership is decided ONCE here instead:
        //   - own drag (started in this window) → routed back to the SOURCE
        //     workspace's controller, the single owner of its resolution
        //   - foreign drag → restored into the active workspace (or a fresh
        //     one when the active tab hosts no workspace)
        window.addEventListener('dragover', e => {
            if (this._activeTab instanceof WorkspaceComponent) { return }
            const dt = e.dataTransfer
            if (!dt || !dt.types.includes(TABBY_DRAG_MIME)) { return }
            e.preventDefault()
            dt.dropEffect = 'move'
        })
        window.addEventListener('drop', e => {
            const dt = e.dataTransfer
            if (!dt || !dt.types.includes(TABBY_DRAG_MIME)) { return }
            const payload = (() => {
                try {
                    return JSON.parse(dt.getData(TABBY_DRAG_MIME)) as NativeDragPayload
                } catch {
                    // fallthrough: not a parseable tabby payload
                    return null
                }
            })()
            if (!payload) { return }
            // Accept only once the payload parses — otherwise the drop stays
            // rejected and the source snaps the session back immediately.
            e.preventDefault()
            this.clearDragPreview()
            if (this.isOwnDrag(payload.dragId)) {
                // Same-window move: the SOURCE workspace owns the resolution.
                const source = this.tabs.find((t): t is WorkspaceComponent =>
                    t instanceof WorkspaceComponent && t.ownsPaneDrag(payload.dragId))
                source?.resolveOwnDrop(e)
                return
            }
            // Foreign drag: restore into the active workspace (or a fresh one
            // when the active tab hosts no workspace).
            payload.savedState = this.hostApp.nativeDragState(payload.dragId)
            void (async () => {
                try {
                    const target = this._activeTab instanceof WorkspaceComponent
                        ? this._activeTab
                        : this.createWorkspaceTab()
                    const restored = await target.acceptProfileIntoWorkspace(payload, e.clientX, e.clientY)
                    if (restored) {
                        this.hostApp.nativeDragAccepted(payload.dragId)
                        this.hostWindow.bringToFront()
                    }
                } catch (err) {
                    console.error('Cross-window drop restore failed:', err)
                }
            })()
        })
    }

    addTabRaw (tab: BaseTabComponent, index: number|null = null): void {
        // Defensive backstop: a session handed straight to addTabRaw (e.g. via
        // tab restore) still gets wrapped instead of becoming a top-level tab.
        if (tab instanceof SessionTab) {
            this.wrapAndAddTab(tab)
            return
        }
        if (index !== null) {
            this.tabs.splice(index, 0, tab)
        } else {
            this.tabs.push(tab)
        }

        this.selectTab(tab)
        this.tabsChanged.next()
        this.tabOpened.next(tab)

        if (this.bootstrapData.isMainWindow) {
            tab.recoveryStateChangedHint$.subscribe(() => {
                this.recoveryStateChangedHint.next()
            })
        }

        tab.titleChange$.subscribe(title => {
            if (tab === this._activeTab) {
                this.hostWindow.setTitle(title)
            }
        })

        tab.destroyed$.subscribe(() => {
            this.removeTab(tab)
            this.tabRemoved.next(tab)
            this.tabClosed.next(tab)
        })

        if (tab instanceof WorkspaceComponent) {
            tab.tabAdded$.subscribe(() => this.emitTabsChanged())
            tab.tabRemoved$.subscribe(() => this.emitTabsChanged())
        }
    }

    removeTab (tab: BaseTabComponent): void {
        const newIndex = Math.min(this.tabs.length - 2, this.tabs.indexOf(tab))
        this.tabs = this.tabs.filter((x) => x !== tab)
        if (tab === this._activeTab) {
            this.selectTab(this.tabs[newIndex])
        }
        this.tabsChanged.next()
    }

    /**
     * Adds a new tab **without** wrapping it in a WorkspaceComponent
     * @param inputs  Properties to be assigned on the new tab component instance
     */
    openNewTabRaw <T extends TopLevelTab> (params: NewTabParameters<T>): T {
        // Defensive backstop: a session handed to the raw path (which should
        // not happen at compile level) is still routed through openNewTab.
        if (params.type.prototype instanceof SessionTab) {
            return this.openNewTab(params as any)
        }
        const tab = this.tabsService.create(params)
        this.addTabRaw(tab)
        return tab
    }

    /**
     * Adds a new tab while wrapping it in a WorkspaceComponent
     * @param inputs  Properties to be assigned on the new tab component instance
     */
    openNewTab <T extends BaseTabComponent> (params: NewTabParameters<T>): T {
        if (params.type as any === WorkspaceComponent) {
            return this.openNewTabRaw(params as any)
        }
        const tab = this.tabsService.create(params)
        const active = this._activeTab
        const sessionSettings = this.config.store.session ?? {}
        const workspaceSettings = this.config.store.workspace ?? {}
        const openInNewWorkspace = workspaceSettings.newSessionOpensInNewWorkspace ?? false
        const appendToPaneByDefault = sessionSettings.appendToPaneByDefault ?? true
        // By this point the workspace type was routed to openNewTabRaw, so the
        // created tab is a session.
        const session = tab as unknown as SessionTab
        if (active instanceof WorkspaceComponent && !openInNewWorkspace && appendToPaneByDefault) {
            // Reuse the focused workspace: add the session to its current pane
            void active.addTabToPane(session)
        } else {
            this.wrapAndAddTab(session)
        }
        return tab
    }

    /**
     * Creates a new empty top-level workspace tab (a "window" that can host
     * panes and sub-tabs), without linking it to any connection
     */
    createWorkspaceTab (): WorkspaceComponent {
        const workspace = this.tabsService.create({ type: WorkspaceComponent })
        this.addTabRaw(workspace)
        return workspace
    }

    /**
     * Adds an existing tab while wrapping it in a WorkspaceComponent
     */
    wrapAndAddTab (tab: SessionTab): WorkspaceComponent {
        const splitTab = this.tabsService.create({ type: WorkspaceComponent })
        splitTab.addTab(tab, null, 'r')
        this.addTabRaw(splitTab)
        return splitTab
    }

    async reopenLastTab (): Promise<BaseTabComponent|null> {
        const token = this.closedTabsStack.pop()
        if (token) {
            const recoveredTab = await this.tabRecovery.recoverTab(token)
            if (recoveredTab) {
                const tab = this.tabsService.create(recoveredTab)
                if (this.activeTab) {
                    this.addTabRaw(tab, this.tabs.indexOf(this.activeTab) + 1)
                } else {
                    this.addTabRaw(tab)
                }
                return tab
            }
        }
        return null
    }

    selectTab (tab: TopLevelTab|null): void {
        if (tab && this._activeTab === tab) {
            this._activeTab.emitFocused()
            return
        }
        if (this._activeTab && this.tabs.includes(this._activeTab)) {
            this.lastTabIndex = this.tabs.indexOf(this._activeTab)
        } else {
            this.lastTabIndex = 0
        }
        if (this._activeTab) {
            this._activeTab.clearActivity()
            this._activeTab.emitBlurred()
            this._activeTab.emitVisibility(false)
        }
        this._activeTab = tab
        this.activeTabChange.next(tab)
        setImmediate(() => {
            this._activeTab?.emitFocused()
            this._activeTab?.emitVisibility(true)
        })
        this.hostWindow.setTitle(this._activeTab?.title)
    }

    getParentTab (tab: BaseTabComponent): WorkspaceComponent|null {
        for (const topLevelTab of this.tabs) {
            if (topLevelTab instanceof WorkspaceComponent) {
                if (topLevelTab.getAllTabs().includes(tab as SessionTab)) {
                    return topLevelTab
                }
            }
        }
        return null
    }

    /** Switches between the current tab and the previously active one */
    toggleLastTab (): void {
        if (!this.lastTabIndex || this.lastTabIndex >= this.tabs.length) {
            this.lastTabIndex = 0
        }
        this.selectTab(this.tabs[this.lastTabIndex])
    }

    nextTab (): void {
        if (!this._activeTab) {
            return
        }
        if (this.tabs.length > 1) {
            const tabIndex = this.tabs.indexOf(this._activeTab)
            if (tabIndex < this.tabs.length - 1) {
                this.selectTab(this.tabs[tabIndex + 1])
            } else if (this.config.store.appearance.cycleTabs) {
                this.selectTab(this.tabs[0])
            }
        }
    }

    previousTab (): void {
        if (!this._activeTab) {
            return
        }
        if (this.tabs.length > 1) {
            const tabIndex = this.tabs.indexOf(this._activeTab)
            if (tabIndex > 0) {
                this.selectTab(this.tabs[tabIndex - 1])
            } else if (this.config.store.appearance.cycleTabs) {
                this.selectTab(this.tabs[this.tabs.length - 1])
            }
        }
    }

    moveSelectedTabLeft (): void {
        if (!this._activeTab) {
            return
        }
        if (this.tabs.length > 1) {
            const tabIndex = this.tabs.indexOf(this._activeTab)
            const bounds = this.getTabReorderBounds(this._activeTab)
            if (tabIndex > bounds.min) {
                this.swapTabs(this._activeTab, this.tabs[tabIndex - 1])
            } else if (this.config.store.appearance.cycleTabs && bounds.max > bounds.min) {
                this.moveTabToIndex(this._activeTab, bounds.max)
            }
        }
    }

    moveSelectedTabRight (): void {
        if (!this._activeTab) {
            return
        }
        if (this.tabs.length > 1) {
            const tabIndex = this.tabs.indexOf(this._activeTab)
            const bounds = this.getTabReorderBounds(this._activeTab)
            if (tabIndex < bounds.max) {
                this.swapTabs(this._activeTab, this.tabs[tabIndex + 1])
            } else if (this.config.store.appearance.cycleTabs && bounds.max > bounds.min) {
                this.moveTabToIndex(this._activeTab, bounds.min)
            }
        }
    }

    swapTabs (a: BaseTabComponent, b: BaseTabComponent): void {
        const i1 = this.tabs.indexOf(a)
        const i2 = this.tabs.indexOf(b)
        if (i1 === -1 || i2 === -1 || a.pinned !== b.pinned) {
            return
        }
        this.tabs[i1] = b
        this.tabs[i2] = a
        this.tabsChanged.next()
    }

    getPinnedTabCount (): number {
        return this.tabs.filter(x => x.pinned).length
    }

    pinTab (tab: BaseTabComponent): void {
        if (tab.pinned) {
            return
        }
        tab.pinned = true
        this.moveTabToIndex(tab, this.getPinnedTabCount() - 1)
    }

    unpinTab (tab: BaseTabComponent): void {
        if (!tab.pinned) {
            return
        }
        tab.pinned = false
        this.moveTabToIndex(tab, this.getPinnedTabCount())
    }

    toggleTabPinned (tab: BaseTabComponent): void {
        if (tab.pinned) {
            this.unpinTab(tab)
        } else {
            this.pinTab(tab)
        }
    }

    getTabReorderBounds (tab: BaseTabComponent): { min: number, max: number } {
        if (!this.tabs.includes(tab)) {
            return { min: 0, max: Math.max(this.tabs.length - 1, 0) }
        }
        if (tab.pinned) {
            return {
                min: 0,
                max: Math.max(this.getPinnedTabCount() - 1, 0),
            }
        }
        return {
            min: this.getPinnedTabCount(),
            max: Math.max(this.tabs.length - 1, 0),
        }
    }

    clampTabIndexToBounds (tab: BaseTabComponent, index: number): number {
        const bounds = this.getTabReorderBounds(tab)
        return Math.max(bounds.min, Math.min(bounds.max, index))
    }

    moveTabToIndex (tab: BaseTabComponent, index: number): void {
        const currentIndex = this.tabs.indexOf(tab)
        if (currentIndex === -1) {
            return
        }
        const targetIndex = this.clampTabIndexToBounds(tab, index)
        if (currentIndex === targetIndex) {
            this.tabsChanged.next()
            return
        }
        this.tabs.splice(currentIndex, 1)
        this.tabs.splice(targetIndex, 0, tab)
        this.tabsChanged.next()
    }

    renameTab (tab: BaseTabComponent): void {
        const modal = this.ngbModal.open(RenameTabModalComponent)
        // Prefill with what the user currently sees (same resolution order
        // as the pane header: rename > profile name / dynamic title).
        const defaultName = tab.parent instanceof WorkspaceComponent
            ? tab.parent.sessionDisplayTitle(tab as SessionTab)
            : tab.customTitle || tab.title
        modal.componentInstance.value = defaultName
        modal.result.then(result => {
            // Custom title is a display-level pin: it never overwrites the
            // underlying dynamic title slot, so clearing it (empty result)
            // cleanly reverts the label to whatever the profile's
            // dynamic-title setting dictates.
            if (tab.parent instanceof WorkspaceComponent) {
                // Session inside a workspace: the pane header resolves the
                // label itself, nothing else to update.
                tab.customTitle = result
            } else if (tab instanceof WorkspaceComponent) {
                if (result) {
                    // Emit before pinning so the window title picks it up
                    tab.setTitle(result)
                } else {
                    tab.updateTitle()
                }
                tab.customTitle = result
            } else {
                tab.setTitle(result)
                tab.customTitle = result
            }
            this.emitTabsChanged()
        }).catch(() => null)
    }

    /** @hidden */
    emitTabsChanged (): void {
        this.tabsChanged.next()
    }

    /**
     * Dismisses the in-window drag preview: the tab-bar insertion divider and
     * the pane drop-hint overlay.
     */
    clearDragPreview (): void {
        this.hideWsInsertionMarker()
        if (this._activeTab instanceof WorkspaceComponent) {
            this._activeTab.setDragHint(null)
        }
    }

    /**
     * Chrome-style insertion caret: a thin highlighted divider shown at the
     * boundary a workspace drop would land at (left edge of the target header,
     * right edge of the last header when appending, or the start of the tab
     * strip for an empty tab bar — between the menu button and the new-tab
     * button). The blank area of the tab strip therefore gives feedback
     * instead of feeling dead.
     */
    private showWsInsertionMarker (x: number, y: number): void {
        const vertical = this.config.store.appearance.tabsLocation === 'left' || this.config.store.appearance.tabsLocation === 'right'
        // Strip-only headers — stray `tab-header` clones from an interrupted
        // drag linger in the body and would skew the index/geometry below.
        const headers = Array.from(document.querySelectorAll('.tab-bar tab-header')) as HTMLElement[]
        const index = this.workspaceDropIndex(x, y)
        const strip = document.querySelector('.tab-bar') as HTMLElement|null
        const stripRect = strip?.getBoundingClientRect()
        let markerX: number
        let markerY: number
        if (headers.length && index < headers.length) {
            const r = headers[index].getBoundingClientRect()
            markerX = vertical ? (stripRect ? stripRect.left + stripRect.width / 2 : 0) : r.left
            markerY = vertical ? r.top : r.top + r.height / 2
        } else if (headers.length) {
            const r = headers[headers.length - 1].getBoundingClientRect()
            markerX = vertical ? (stripRect ? stripRect.left + stripRect.width / 2 : 0) : r.right
            markerY = vertical ? r.bottom : r.top + r.height / 2
        } else {
            const tabsEl = document.querySelector('.tab-bar .tabs') as HTMLElement|null
            const tr = tabsEl?.getBoundingClientRect()
            markerX = vertical
                ? (stripRect ? stripRect.left + stripRect.width / 2 : (tr?.left ?? 0))
                : (tr?.left ?? stripRect?.left ?? 0) + 6
            markerY = vertical
                ? (tr?.top ?? stripRect?.top ?? 0) + 6
                : (stripRect ? stripRect.top + stripRect.height / 2 : 19)
        }
        // Vertical (left/right) tab bar: a horizontal divider spanning the full
        // strip width; horizontal tab bar: a vertical divider the header height.
        const caretW = vertical ? Math.max((stripRect ? stripRect.width : 120) - 12, 1) : 3
        const caretH = vertical ? 3 : Math.min(stripRect ? stripRect.height - 6 : 30, 30)
        // Guard against a malformed header snapshot (mid-CDK-sort transforms /
        // clones) producing an off-screen caret: clamp into the viewport.
        markerX = Math.min(Math.max(markerX, 0), window.innerWidth)
        markerY = Math.min(Math.max(markerY, 0), window.innerHeight)
        const marker = this.ensureWsInsertionMarker()
        marker.style.width = `${caretW}px`
        marker.style.height = `${caretH}px`
        marker.style.left = `${markerX}px`
        marker.style.top = `${markerY}px`
    }

    private ensureWsInsertionMarker (): HTMLDivElement {
        if (!this.wsInsertionMarker) {
            const el = document.createElement('div')
            el.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;transform:translate(-50%,-50%);' +
                'border-radius:2px;background:var(--theme-primary,#0078d4);' +
                'box-shadow:0 0 8px color-mix(in srgb, var(--theme-primary,#0078d4) 65%, transparent)'
            document.body.appendChild(el)
            this.wsInsertionMarker = el
        }
        return this.wsInsertionMarker
    }

    private hideWsInsertionMarker (): void {
        this.wsInsertionMarker?.remove()
        this.wsInsertionMarker = null
    }

    /** @hidden dismiss the CDK tab-reorder divider. */
    hideTabReorderHint (): void {
        this.hideWsInsertionMarker()
    }

    /**
     * Close this window when its last tab left (e.g. the last workspace was
     * moved to another window and `lastTabClosesWindow` is on) — mirrors the
     * tabClosed$ handler for normal closes.
     */
    private maybeCloseWindowWhenEmpty (): void {
        if (!this.tabs.length && this.config.store.appearance.lastTabClosesWindow) {
            this.hostWindow.close()
        }
    }

    /**
     * Source side of a native workspace-tab drag: set an active-drag origin for
     * this window and register the drag id. The (async) recovery token is
     * serialized and pushed out-of-band once ready, so the target window can
     * rebuild the workspace even though the DataTransfer only carries the id.
     */
    async beginWorkspaceNativeDrag (tab: WorkspaceComponent, dragId: string): Promise<void> {
        // Neutralize the title-bar app-region:drag areas for the gesture, or
        // Chromium would swallow dragover/drop over them and report the drag as
        // having left the window (see app/src/global.scss .ws-workspace-drag).
        document.body.classList.add('ws-workspace-drag')
        // The sessions must survive our copy being torn down mid-gesture (a
        // cross-window restore re-attaches them by PTY id from the token).
        tab.keepAllSessionsAlive(true)
        this.hostApp.nativeDragStart(dragId, null)
        this.registerOwnDrag(dragId)
        if (this.workspaceNativeDrag?.committedSub) {
            this.workspaceNativeDrag.committedSub.unsubscribe()
        }
        const committedSub = this.hostApp.nativeDragCommitted$.subscribe(committedId => {
            const drag = this.workspaceNativeDrag
            if (!drag || drag.dragId !== committedId || drag.settled) {
                return
            }
            drag.settled = true
            drag.committedSub.unsubscribe()
            if (drag.acceptTimer) {
                window.clearTimeout(drag.acceptTimer)
            }
            this.workspaceNativeDrag = null
            this.hostApp.nativeDragEnd(drag.dragId)
            // Another window rebuilt our workspace from the token: drop this
            // copy. The sessions carry keepPTYAlive and are re-attached there.
            void drag.tab.destroy()
            this.maybeCloseWindowWhenEmpty()
        })
        this.workspaceNativeDrag = { dragId, tab, committedSub, settled: false, acceptTimer: null }
        try {
            const token = await this.tabRecovery.getFullRecoveryToken(tab, { includeState: true })
            if (token) {
                this.hostApp.nativeDragStateUpdate(dragId, JSON.parse(JSON.stringify(token)))
            }
        } catch (err) {
            console.error('[app] workspace drag state serialization failed:', err)
        }
    }

    /**
     * Source side: the workspace drag ended. VSCode semantics: the decision
     * rests ENTIRELY on whether any Tabby window was hovered at release
     * ([[isWorkspaceDraggedOver]]) — never on the dropEffect, which a foreign
     * drop target (another app swallowing the release, e.g. an editor
     * accepting with dropEffect 'move') reports as a success just the same.
     * Hovered → the destination rebuilds the workspace and acks
     * ([[nativeDragCommitted$]] drops this copy). Not hovered → detach into
     * a new window at the release point (desktop, foreign app, Esc cancel).
     */
    endWorkspaceNativeDrag (tab: WorkspaceComponent, _dropEffect: string|undefined): void {
        document.body.classList.remove('ws-workspace-drag')
        this.hideWsInsertionMarker()
        const sourceHeader = document.querySelector('tab-header.ws-dragging')
        const drag = this.workspaceNativeDrag
        // No pending drag: the drop was already settled locally (same-window
        // reorder in `handleWorkspaceDrop`) or committed (cross-window restore
        // destroyed this copy). The hidden header comes back unless the tab is
        // already gone. Never fall through to a second action.
        if (!drag) {
            sourceHeader?.classList.remove('ws-dragging')
            return
        }
        if (drag.tab !== tab) {
            sourceHeader?.classList.remove('ws-dragging')
            return
        }
        if (isWorkspaceDraggedOver()) {
            if (_dropEffect !== 'move') {
                // Hovered THIS window but the drop was rejected (released over
                // the body outside the strip): nothing is coming — settle
                // right away instead of waiting on an ack that will never
                // arrive. The tab stays exactly where it was.
                this.settleWorkspaceDrag(drag)
                document.querySelector('tab-header.ws-dragging')?.classList.remove('ws-dragging')
                return
            }
            // A Tabby window was under the cursor when the button went up. The
            // destination rebuilds the workspace asynchronously and then acks;
            // keep the commit listener AND the main-process registry entry
            // alive until that ack arrives, otherwise a slow restore would end
            // up with the workspace duplicated (target made its copy while the
            // source already released everything). The header stays hidden
            // meanwhile (commit destroys it); if the ack never arrives, bring
            // it back.
            drag.acceptTimer = window.setTimeout(() => {
                document.querySelector('tab-header.ws-dragging')?.classList.remove('ws-dragging')
                drag.settled = true
                drag.committedSub.unsubscribe()
                this.workspaceNativeDrag = null
                this.hostApp.nativeDragEnd(drag.dragId)
            }, 5000)
            return
        }
        // Released over NO Tabby window: detach into a new window at the
        // release point (unless the user turned drag-to-open-window off —
        // vscode `workbench.editor.dragToOpenWindow` parity). No host able to
        // report the cursor (web build) or a vanishing tab keeps the
        // workspace here instead.
        this.settleWorkspaceDrag(drag)
        const point = this.hostApp.getCursorScreenPoint()
        if (this.config.store.workspace?.dragToOpenWindow !== false && point && this.tabs.includes(drag.tab)) {
            void this.moveWorkspaceToWindow(drag.tab, { x: point.x - 48, y: point.y - 20 })
        } else {
            document.querySelector('tab-header.ws-dragging')?.classList.remove('ws-dragging')
        }
    }

    /** Teardown shared by every local resolution of a source workspace drag:
     * marks it settled, releases the main-process registration and the commit
     * listener, and lets the sessions resume normal (non-keep-alive) teardown. */
    private settleWorkspaceDrag (drag: { dragId: string, tab: WorkspaceComponent, committedSub: Subscription, settled: boolean, acceptTimer: number|null }): void {
        drag.settled = true
        drag.committedSub.unsubscribe()
        if (drag.acceptTimer) {
            window.clearTimeout(drag.acceptTimer)
        }
        this.workspaceNativeDrag = null
        this.hostApp.nativeDragEnd(drag.dragId)
        drag.tab.keepAllSessionsAlive(false)
    }

    async moveWorkspaceToWindow (tab: WorkspaceComponent, screenPoint?: { x: number, y: number }): Promise<void> {
        const token = await this.tabRecovery.getFullRecoveryToken(tab, { includeState: true })
        if (!token) {
            return
        }
        const transferToken = JSON.parse(JSON.stringify(token))
        tab.keepAllSessionsAlive(true)
        void tab.destroy()
        this.maybeCloseWindowWhenEmpty()
        this.hostApp.newWindow({
            recoveryToken: transferToken,
            x: screenPoint?.x,
            y: screenPoint?.y,
        })
    }

    /**
     * Receiving/display side of native workspace-tab drags. EVERY window
     * accepts the drop anywhere in its bounds (a rejected dragover would
     * poison dragend with a stale dropEffect): the same window reorders when
     * the release lands on its strip and keeps the workspace in place when it
     * lands on the body; another window rebuilds the workspace from the
     * out-of-band recovery token wherever the release landed. A release over
     * NO window at all detaches into a new one (see endWorkspaceNativeDrag).
     * A workspace is never merged INTO another workspace.
     */
    private setupWorkspaceNativeDrop (): void {
        window.addEventListener('dragover', event => {
            const dt = event.dataTransfer
            if (!dt) {
                return
            }
            if (!dt.types?.includes(TABBY_WORKSPACE_DRAG_MIME)) {
                return
            }
            // Accept EVERYWHERE (vscode editor-area parity): a rejected
            // dragover would leave dragend reporting a STALE dropEffect from
            // the last accepted hover, breaking the detach decision. The
            // insertion caret previews strip landings only.
            event.preventDefault()
            dt.dropEffect = 'move'
            if (this.isPointOverTabStrip(event.clientX, event.clientY)) {
                this.showWsInsertionMarker(event.clientX, event.clientY)
            } else {
                this.hideWsInsertionMarker()
            }
        })

        window.addEventListener('drop', event => {
            const dt = event.dataTransfer
            if (!dt) {
                return
            }
            if (!dt.types?.includes(TABBY_WORKSPACE_DRAG_MIME)) {
                return
            }
            this.clearDragPreview()
            let payload: WorkspaceDragPayload|null = null
            try {
                payload = JSON.parse(dt.getData(TABBY_WORKSPACE_DRAG_MIME))
            } catch {
                // fallthrough: not one of our workspace drags
            }
            if (!payload) {
                return
            }
            event.preventDefault()
            // Same-window release outside the strip: NOT a reorder — vscode
            // keeps the editor in place when dropped over its own area. The
            // drop IS accepted (so dragend stays consistent) and the workspace
            // settles untouched, right away — no ack will ever come.
            if (this.workspaceNativeDrag && this.workspaceNativeDrag.dragId === payload.dragId &&
                !this.isPointOverTabStrip(event.clientX, event.clientY)) {
                this.settleWorkspaceDrag(this.workspaceNativeDrag)
                document.querySelector('tab-header.ws-dragging')?.classList.remove('ws-dragging')
                return
            }
            void this.handleWorkspaceDrop(payload, event.clientX, event.clientY)
        })

        window.addEventListener('dragleave', event => {
            const dt = event.dataTransfer
            if (!dt || !dt.types?.includes(TABBY_WORKSPACE_DRAG_MIME)) {
                return
            }
            // An interior element transition fires dragleave too, but the next
            // dragover immediately redraws the marker; leaving the document
            // keeps it hidden.
            if (dragLeftDocument(event)) {
                this.hideWsInsertionMarker()
            }
        })
    }

    /**
     * Resolves a workspace drop in this window: the pointer's position over the
     * tab bar decides the insertion index (per-header half). Same-window drops
     * just reorder the existing tab; cross-window drops rebuild the workspace
     * from the out-of-band recovery token and acknowledge the drag so the
     * source drops its copy.
     */
    private async handleWorkspaceDrop (payload: WorkspaceDragPayload, x: number, y: number): Promise<void> {
        const drag = this.workspaceNativeDrag
        const index = this.workspaceDropIndex(x, y)
        if (drag && drag.dragId === payload.dragId) {
            // Returned to its own window: the workspace never left — just
            // reorder it locally and keep it here. `workspaceDropIndex` counts
            // the dragged (collapsed) header, i.e. the index is into the array
            // WITH the tab still in place; moveTabToIndex removes first, so a
            // forward move must shed one slot or the tab lands one position
            // PAST the highlighted insertion caret.
            this.settleWorkspaceDrag(drag)
            const currentIndex = this.tabs.indexOf(drag.tab)
            const targetIndex = index > currentIndex ? index - 1 : index
            this.moveTabToIndex(drag.tab, targetIndex)
            this.selectTab(drag.tab)
            return
        }
        if (this.selfDragIds.includes(payload.dragId)) {
            // A drop of one of OUR OWN earlier drags arriving late (the real
            // drop was missed and already resolved above or by the rejected
            // path): recreating it here would duplicate the workspace inside
            // the source window. Ignore.
            this.clearDragPreview()
            return
        }
        // Cross-window: rebuild the workspace from the out-of-band token. The
        // token is serialized asynchronously on the source side, so it may not
        // be published yet when a fast drop arrives — retry briefly before
        // giving up.
        let token = this.hostApp.nativeDragState(payload.dragId)
        if (!token) {
            for (let attempt = 0; attempt < 15 && !token; attempt++) {
                await new Promise(r => setTimeout(r, 100))
                token = this.hostApp.nativeDragState(payload.dragId)
            }
        }
        if (!token) {
            return
        }
        try {
            const params = await this.tabRecovery.recoverTab(token)
            if (!params) {
                return
            }
            const tab = this.tabsService.create(params as NewTabParameters<any>)
            this.addTabRaw(tab, index)
            this.selectTab(tab)
            this.hostApp.nativeDragAccepted(payload.dragId)
            // VSCode parity: a cross-window drop RAISES the receiving window —
            // otherwise a drop that fell through an overlaying app silently
            // lands in a window behind it and looks lost.
            this.hostWindow.bringToFront()
        } catch (err) {
            console.error('[app] workspace drop restore failed:', err)
        }
    }

    /** Whether the point sits inside this window's tab strip (with a small
      * vertical tolerance for the window edge the bar hugs). */
    private isPointOverTabStrip (x: number, y: number): boolean {
        const strip = document.querySelector('.tab-bar') as HTMLElement|null
        if (!strip) {
            return false
        }
        const r = strip.getBoundingClientRect()
        return x >= r.left && x <= r.right && y >= r.top - 2 && y <= r.bottom + 2
    }

    /**
     * Tab-bar insertion index under a client point. Each header's leading half
     * inserts before it; elsewhere append. Left/right tab bars split vertically.
     */
    private workspaceDropIndex (x: number, y: number): number {
        // Only count headers that are actually in the tab strip — a stray
        // `tab-header` clone (an interrupted drag) can linger in the DOM and
        // must not shift the indices.
        const headers = document.querySelectorAll('.tab-bar tab-header')
        if (headers.length !== this.tabs.length) {
            return this.tabs.length
        }
        const vertical = this.config.store.appearance.tabsLocation === 'left' || this.config.store.appearance.tabsLocation === 'right'
        for (let i = 0; i < headers.length; i++) {
            const rect = (headers[i] as HTMLElement).getBoundingClientRect()
            if (vertical) {
                if (y < rect.top + rect.height / 2) {
                    return i
                }
            } else if (x < rect.left + rect.width / 2) {
                return i
            }
        }
        return this.tabs.length
    }

    async closeTab (tab: BaseTabComponent, checkCanClose?: boolean, ignorePinned = false): Promise<void> {
        if (!this.tabs.includes(tab)) {
            return
        }
        if (tab.effectivelyPinned && !ignorePinned) {
            return
        }
        if (checkCanClose && !await tab.canClose()) {
            return
        }
        const token = await this.tabRecovery.getFullRecoveryToken(tab, { includeState: true })
        if (token) {
            this.closedTabsStack.push(token)
            this.closedTabsStack = this.closedTabsStack.slice(-5)
        }
        tab.destroy()
    }

    async duplicateTab (tab: BaseTabComponent): Promise<BaseTabComponent|null> {
        const dup = await this.tabsService.duplicate(tab)
        if (dup) {
            this.addTabRaw(dup, this.tabs.indexOf(tab) + 1)
        }
        return dup
    }

    async restartTab (tab: BaseTabComponent): Promise<BaseTabComponent|null> {
        if (!this.tabs.includes(tab)) {
            return null
        }

        const token = await this.tabRecovery.getFullRecoveryToken(tab, { includeState: true })
        if (!token) {
            return null
        }

        const recoveredTab = await this.tabRecovery.recoverTab(token)
        if (!recoveredTab) {
            return null
        }

        const reopened = this.tabsService.create(recoveredTab)
        this.addTabRaw(reopened, this.tabs.indexOf(tab) + 1)
        await this.closeTab(tab, false, true)

        return reopened
    }

    /**
     * Attempts to close all tabs, returns false if one of the tabs blocked closure
     */
    async closeAllTabs (): Promise<boolean> {
        for (const tab of this.tabs) {
            if (!await tab.canClose()) {
                return false
            }
        }
        for (const tab of this.tabs) {
            tab.destroy(true)
        }
        return true
    }

    async closeWindow (): Promise<void> {
        // Snapshot the tabs while still enabled; disabling first would make
        // the save a no-op (saveTabs gates on `enabled`).
        await this.tabRecovery.saveTabs(this.tabs)
        this.tabRecovery.enabled = false
        if (await this.closeAllTabs()) {
            this.hostWindow.close()
        } else {
            this.tabRecovery.enabled = true
        }
    }

    /** @hidden */
    emitReady (): void {
        this.ready.next()
        this.ready.complete()
        this.hostApp.emitReady()
    }

    /** @hidden */
    emitTabDragStarted (tab: BaseTabComponent): void {
        this.tabDragActive.next(tab)
    }

    /** @hidden */
    emitTabDragEnded (): void {
        this.tabDragActive.next(null)
    }

    /**
     * Returns an observable that fires once
     * the tab's internal "process" (see [[BaseTabProcess]]) completes
     */
    observeTabCompletion (tab: BaseTabComponent): Observable<void> {
        if (!this.completionObservers.has(tab)) {
            const observer = new CompletionObserver(tab)
            observer.destroyed$.subscribe(() => {
                this.stopObservingTabCompletion(tab)
            })
            this.completionObservers.set(tab, observer)
        }
        return this.completionObservers.get(tab)!.done$
    }

    stopObservingTabCompletion (tab: BaseTabComponent): void {
        this.completionObservers.delete(tab)
    }

    // Deprecated
    showSelector <T> (name: string, options: SelectorOption<T>[]): Promise<T> {
        return this.selector.show(name, options)
    }

    explodeTab (tab: WorkspaceComponent): WorkspaceComponent[] {
        const result: WorkspaceComponent[] = []
        for (const child of tab.getAllTabs().slice(1)) {
            tab.removeTab(child)
            result.push(this.wrapAndAddTab(child))
        }
        return result
    }

    combineTabsInto (into: WorkspaceComponent): void {
        this.explodeTab(into)

        // Only sessions can live inside a workspace's panes; whole-page hosts
        // (settings / welcome / release notes) stay where they are.
        let allChildren: SessionTab[] = []
        for (const tab of this.tabs) {
            if (into === tab) {
                continue
            }
            if (tab instanceof WorkspaceComponent) {
                allChildren = allChildren.concat(tab.getAllTabs())
            }
        }

        let x = 1
        let previous: SessionTab|null = null
        const stride = Math.ceil(Math.sqrt(allChildren.length + 1))
        for (const child of allChildren) {
            void into.addTab(child, x ? previous : null, x ? 'r' : 'b')
            previous = child
            x = (x + 1) % stride
        }

        into.equalize()
    }
}
