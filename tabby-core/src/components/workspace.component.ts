import { Observable, Subject, takeWhile } from 'rxjs'
import { Component, Injectable, HostBinding, ViewChild, ViewContainerRef, EmbeddedViewRef, AfterViewInit, OnDestroy, Injector } from '@angular/core'
import { BaseTabComponent, BaseTabProcess, GetRecoveryTokenOptions } from './baseTab.component'
import { TopLevelTab } from '../api/topLevelTab'
import { TabRecoveryProvider, RecoveryToken } from '../api/tabRecovery'
import { TabsService, NewTabParameters } from '../services/tabs.service'
import { HotkeysService } from '../services/hotkeys.service'
import { TabRecoveryService } from '../services/tabRecovery.service'
import { PlatformService } from '../api/platform'
import { AppService } from '../services/app.service'
import { TranslateService } from '@ngx-translate/core'
import { ActionSurface } from '../api/action'
import { actionsToMenuItems } from '../api/adapters'
import { ActionRegistry } from '../services/action.service'

import { SplitDirection, SplitContainer, Pane, TabView, SPLITTER_BAND, SplitSpannerInfo, SplitTabPaneHeaderData, findPaneForTab, findParentContainer, collectPanes, sideDirectionOf, addPaneInto, cleanNode, resolveRelativeTab, SplitDropZoneInfo, PanePlacement, layoutTree } from './workspace.layout'
export { SplitOrientation, SplitDirection, SplitContainer, Pane, TabView, SPLITTER_BAND, PANE_MIN_SIZE, minSizeOf, SplitSpannerInfo, SplitTabPaneHeaderData, SplitDropZoneInfo } from './workspace.layout'
import { PaneDragController, PaneDragHost, DragHintState } from './workspace.dragDrop'
import { PaneNavigation, PaneNavigationHost } from './workspace.navigation'
import { HostAppService } from '../api/hostApp'
import { SessionTab } from '../api/session'

/**
 * Split tab is a tab (a "window"/workspace) that can hold multiple panes,
 * each of which can host multiple tabs. You'll mainly encounter it inside
 * [[AppService]].tabs
 */
@Component({
    selector: 'split-tab',
    template: `
        <ng-container #vc></ng-container>
        <split-tab-spanner
            *ngFor='let spanner of _spanners; trackBy: spannerBy'
            [container]='spanner.container'
            [index]='spanner.index'
            [x]='spannerGeom(spanner).x'
            [y]='spannerGeom(spanner).y'
            [w]='spannerGeom(spanner).w'
            [h]='spannerGeom(spanner).h'
            (change)='onSpannerAdjusted(spanner)'
            (resizing)='onSpannerResizing($event)'
        ></split-tab-spanner>
        <split-tab-drop-zone
            *ngFor='let dropZone of _dropZones'
            [parent]='this'
            [dropZone]='dropZone'
            (tabDropped)='onTabDropped($event, dropZone)'
        >
        </split-tab-drop-zone>
<div
            *ngFor='let header of _paneHeaders; trackBy: paneHeaderBy'
            class='pane-header'
            (dblclick)='duplicatePaneActiveSession($event, header.pane)'
            [ngStyle]='{left: header.x + "px", top: header.y + "px", width: header.w + "px", height: header.h + "px"}'
        >
            <span
                *ngFor='let paneTab of header.pane.tabs; trackBy: paneTabBy; let idx = index'
                class='pane-tab'
                [class.active]='paneTab === (header.pane.activeTab ?? header.pane.tabs[0])'
                (click)='activatePaneTab(header.pane, paneTab)'
                (dblclick)='duplicatePaneActiveTab($event, header.pane, paneTab)'
                (contextmenu)='openPaneTabContextMenu($event, paneTab)'
                (pointerdown)='onPaneTabPointerDown($event, paneTab)'
            ><i class='fas fa-user-shield pane-tab-admin' *ngIf='isAdminSession(paneTab)'></i>{{paneTab.customTitle || sessionDisplayTitle(paneTab)}}</span>
        </div>
        <div class='pane-drop-hint'
            [class.visible]='_dragHintVisible'
            [class.side-all]='_dragHintSide === "all"'
            [class.side-l]='_dragHintSide === "l"'
            [class.side-r]='_dragHintSide === "r"'
            [class.side-t]='_dragHintSide === "t"'
            [class.side-b]='_dragHintSide === "b"'
            [ngStyle]='{left: _dragHintX + "px", top: _dragHintY + "px", width: _dragHintW + "px", height: _dragHintH + "px"}'
        ></div>
    `,
    styleUrls: ['./workspace.component.scss'],
})
export class WorkspaceComponent extends TopLevelTab implements AfterViewInit, OnDestroy, PaneDragHost, PaneNavigationHost {
    static DIRECTIONS: SplitDirection[] = ['t', 'r', 'b', 'l']

    /**
     * Default workspace icon rendered in the tab bar. Png is inlined as a data
     * URL by webpack and injected as an <img>, which profile-icon renders.
     */
    static readonly workspaceIcon = '<img src="' + require('../icons/workspace.png') + '">'

    /** @hidden */
    private _workspaceIcon: string|null = null

    /** @hidden AppService resolved lazily to avoid a module cycle at boot */
    private _app: AppService|null = null

    private get app (): AppService {
        return this._app!
    }

    /** @hidden */
    @ViewChild('vc', { read: ViewContainerRef }) viewContainer: ViewContainerRef

    /**
     * Top-level split container
     */
    root: SplitContainer

    /** @hidden */
    _recoveredState: any

    /** @hidden */
    _recoveredTitle: string|null = null

    /** @hidden workspace colour restored from the recovery token */
    _recoveredColor: string|null = null

    /** @hidden */
    _profileName: string|null = null

    /** @hidden */
    _spanners: SplitSpannerInfo[] = []

    /** @hidden */
    _dropZones: SplitDropZoneInfo[] = []

    /** @hidden */
    _paneHeaders: SplitTabPaneHeaderData[] = []

    /** @hidden */
    isEmpty = true

    /** @hidden */
    _spannerResizing = false

    /** @hidden disables pane/zone/header recreation while the user drags a spanner */
    _pixelResizing = false

    /** @hidden cached measured host size (px) so removals/drags don't re-read a zero rect */
    _canvasW = 800
    _canvasH = 600

    @HostBinding('class.resizing') get resizingClass (): boolean { return this._pixelResizing }

    private resizeObserver: ResizeObserver|null = null
    private layoutFrame = false

    /**
     * Height of the pane header strip, in pixels
     */
    readonly paneHeaderHeight = 28

    /**
     * Disables display of dynamic window/tab title provided by the shell
     */
    disableDynamicTitle = false

    /** @hidden */
    focusedTab: SessionTab|null = null
    private viewRefs: Map<SessionTab, EmbeddedViewRef<any>> = new Map()

    /** @hidden Pane-tab drag gesture controller (self-contained drag state) */
    private readonly paneDrag: PaneDragController
    /** Monotonic guard for stale cross-window drag results. */
    private crossWindowArmId = 0
    /** @hidden Pane/session keyboard navigation + splitter-step controller */
    private readonly paneNav: PaneNavigation

    /** @hidden Drag overlay preview state. Setters are the PaneDragHost contract. */
    setDragHint (hint: DragHintState|null): void {
        this._dragHintVisible = hint?.visible ?? false
        this._dragHintSide = hint?.side ?? 'all'
        this._dragHintX = hint?.x ?? 0
        this._dragHintY = hint?.y ?? 0
        this._dragHintW = hint?.w ?? 0
        this._dragHintH = hint?.h ?? 0
    }

    /** @hidden PaneNavigationHost */
    get paneResizeStep (): number {
        return this.config.store.terminal.paneResizeStep ?? 0.1
    }

    /** @hidden PaneDragHost / PaneNavigationHost */
    elementFor (tab: SessionTab): HTMLElement|undefined {
        const ref = this.viewRefs.get(tab)
        return ref?.rootNodes[0] as HTMLElement|undefined
    }

    /** @hidden PaneDragHost */
    emitTabAdopted (tab: SessionTab): void {
        this.tabAdopted.next(tab)
    }

    /** Drag overlay hint (demo-style preview) */
    _dragHintVisible = false
    _dragHintX = 0
    _dragHintY = 0
    _dragHintW = 0
    _dragHintH = 0
    _dragHintSide: SplitDirection|'all' = 'all'

    private tabAdded = new Subject<BaseTabComponent>()
    private tabAdopted = new Subject<BaseTabComponent>()
    private tabRemoved = new Subject<BaseTabComponent>()
    private splitAdjusted = new Subject<SplitSpannerInfo>()
    private focusChanged = new Subject<BaseTabComponent>()
    private initialized = new Subject<void>()

    get tabAdded$ (): Observable<BaseTabComponent> { return this.tabAdded }

    /**
     * Fired when an existing top-level tab is dragged into this tab
     */
    get tabAdopted$ (): Observable<BaseTabComponent> { return this.tabAdopted }

    get tabRemoved$ (): Observable<BaseTabComponent> { return this.tabRemoved }

    /**
     * Fired when split ratio is changed for a given spanner
     */
    get splitAdjusted$ (): Observable<SplitSpannerInfo> { return this.splitAdjusted }

    /**
     * Fired when a different sub-tab gains focus
     */
    get focusChanged$ (): Observable<BaseTabComponent> { return this.focusChanged }

    /**
     * Fired once tab layout is created and child tabs can be added
     */
    get initialized$ (): Observable<void> { return this.initialized }

    /** @hidden */
    constructor (
        private hotkeys: HotkeysService,
        private tabsService: TabsService,
        private tabRecovery: TabRecoveryService,
        private platform: PlatformService,
        private translate: TranslateService,
        private actions: ActionRegistry,
        private injector: Injector,
        private hostApp: HostAppService,
    ) {
        super(injector)
        this.root = new SplitContainer()
        this.setTitle(this.translate.instant('Untitled workspace'))

        // Monotonic guard: each arming of a cross-window session drag gets a
        // fresh id so stale committed/cancelled/subscription results from a
        // previous (cancelled) attempt are ignored.
        this.paneDrag = new PaneDragController(this)
        this.paneNav = new PaneNavigation(this)

        // app.service imports this component and this component imported
        // AppService in the constructor signature → a circular module graph
        // that could trip "Cannot access 'AppService' before initialization".
        // Resolve it lazily from the DI graph instead.
        this._app = this.injector.get(AppService)

        this.focused$.subscribe(() => {
            this.getAllTabs().forEach(x => x.emitFocused())
            if (this.focusedTab) {
                this.focus(this.focusedTab)
            } else {
                this.focusAnyIn(this.root)
            }
        })
        this.blurred$.subscribe(() => this.getAllTabs().forEach(x => x.emitBlurred()))
        this.visibility$.subscribe(visibility => this.getAllTabs().forEach(x => x.emitVisibility(visibility)))

        this.tabAdded$.subscribe(() => this.updateTitle())
        this.tabRemoved$.subscribe(() => this.updateTitle())

        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus || !this.focusedTab) {
                return
            }
            switch (hotkey) {
                case 'split-right':
                    this.splitTab(this.focusedTab, 'r')
                    break
                case 'split-bottom':
                    this.splitTab(this.focusedTab, 'b')
                    break
                case 'split-top':
                    this.splitTab(this.focusedTab, 't')
                    break
                case 'split-left':
                    this.splitTab(this.focusedTab, 'l')
                    break
                case 'pane-nav-left':
                    this.paneNav.navigate('l')
                    break
                case 'pane-nav-right':
                    this.paneNav.navigate('r')
                    break
                case 'pane-nav-up':
                    this.paneNav.navigate('t')
                    break
                case 'pane-nav-down':
                    this.paneNav.navigate('b')
                    break
                case 'session-nav-previous':
                    this.paneNav.navigateLinear(-1)
                    break
                case 'session-nav-next':
                    this.paneNav.navigateLinear(1)
                    break
                case 'pane-nav-1':
                    this.paneNav.navigateSpecific(0)
                    break
                case 'pane-nav-2':
                    this.paneNav.navigateSpecific(1)
                    break
                case 'pane-nav-3':
                    this.paneNav.navigateSpecific(2)
                    break
                case 'pane-nav-4':
                    this.paneNav.navigateSpecific(3)
                    break
                case 'pane-nav-5':
                    this.paneNav.navigateSpecific(4)
                    break
                case 'pane-nav-6':
                    this.paneNav.navigateSpecific(5)
                    break
                case 'pane-nav-7':
                    this.paneNav.navigateSpecific(6)
                    break
                case 'pane-nav-8':
                    this.paneNav.navigateSpecific(7)
                    break
                case 'pane-nav-9':
                    this.paneNav.navigateSpecific(8)
                    break
                case 'close-session':
                    this.focusedTab.destroy()
                    break
                case 'splitter-top-up':
                    this.paneNav.moveSplitter('up', 1)
                    break
                case 'splitter-top-down':
                    this.paneNav.moveSplitter('up', -1)
                    break
                case 'splitter-bottom-up':
                    this.paneNav.moveSplitter('down', -1)
                    break
                case 'splitter-bottom-down':
                    this.paneNav.moveSplitter('down', 1)
                    break
                case 'splitter-left-left':
                    this.paneNav.moveSplitter('left', 1)
                    break
                case 'splitter-left-right':
                    this.paneNav.moveSplitter('left', -1)
                    break
                case 'splitter-right-left':
                    this.paneNav.moveSplitter('right', -1)
                    break
                case 'splitter-right-right':
                    this.paneNav.moveSplitter('right', 1)
                    break
            }
        })
    }

    /** @hidden */
    async ngAfterViewInit (): Promise<void> {
        if (this._recoveredState) {
            await this.recoverContainer(this.root, this._recoveredState)
            this.updateTitle()
            this.layout()
            setTimeout(() => {
                if (this.hasFocus) {
                    for (const tab of this.getAllTabs()) {
                        this.focus(tab)
                    }
                }
            }, 100)

            // Propagate visibility to new children
            this.emitVisibility(this.visibility.value)
        }
        // Re-apply the workspace-owned colour (survives session churn/restart).
        if (this._recoveredColor !== null) {
            this.color = this._recoveredColor
        }
        this.setupResizeObserver()
        this.initialized.next()
        this.initialized.complete()
    }

    private setupResizeObserver (): void {
        const host = this.hostElement()
        if (!host || typeof ResizeObserver === 'undefined') { return }
        this.resizeObserver = new ResizeObserver(() => this.scheduleLayout())
        this.resizeObserver.observe(host)
    }

    /** @hidden the split-tab host element anchoring all absolutely positioned children */
    private hostElement (): HTMLElement|null {
        const anchor = this.viewContainer.element.nativeElement
        if (!anchor) { return null }
        return (anchor.parentNode ?? anchor) as HTMLElement
    }

    private scheduleLayout (): void {
        if (this.layoutFrame) { return }
        this.layoutFrame = true
        requestAnimationFrame(() => {
            this.layoutFrame = false
            this.layout()
        })
    }

    /** @hidden */
    ngOnDestroy (): void {
        // An in-flight pane-tab drag installs window listeners — drop them
        // before teardown so the gesture can't keep a live reference to us.
        this.paneDrag.abort()
        this.resizeObserver?.disconnect()
        this.resizeObserver = null
        this.tabAdded.complete()
        this.tabRemoved.complete()
        this.splitAdjusted.complete()
        this.focusChanged.complete()
        super.ngOnDestroy()
    }

    /** @returns Flat list of all sessions in this workspace */
    getAllTabs (): SessionTab[] {
        return this.root.getAllTabs()
    }

    getFocusedTab (): SessionTab|null {
        return this.focusedTab
    }

    focus (tab: SessionTab): void {
        this.focusedTab = tab
        const pane = this.getPaneOf(tab)
        if (pane) {
            pane.activeTab = tab
        }
        for (const x of this.getAllTabs()) {
            if (x !== tab) {
                x.emitBlurred()
            }
        }
        tab.emitFocused()
        this.focusChanged.next(tab)

        // Focus never changes geometry: the pane cell and header stay put, only
        // the visible/inactive pane-tab classes may flip. A full layout() here
        // would rebuild every spanner/drop-zone/header and re-style all pane
        // DOM on each click (and on every mousemove with focus-follows-mouse).
        this.refreshPaneFocus()
    }

    /**
     * Cheap focus-only pass: toggles the `focused`/`pane-tab-inactive` classes
     * of the pane-tab DOM without recomputing layout.
     */
    private refreshPaneFocus (): void {
        for (const [tab, ref] of this.viewRefs) {
            const pane = this.getPaneOf(tab)
            const isActive = pane !== null && pane.tab === tab
            const element = ref.rootNodes[0]
            element?.classList.toggle('pane-tab-inactive', !isActive)
            element?.classList.toggle('focused', isActive)
        }
    }

    /** @hidden */
    activatePaneTab (pane: Pane, tab: SessionTab): void {
        pane.activeTab = tab
        this.focus(tab)
    }

    /**
     * Keeps pane-header DOM stable across re-layouts, otherwise the second
     * click of a double-click lands on a freshly recreated node and the
     * browser never fires `dblclick`.
     */
    paneHeaderBy (_index: number, header: SplitTabPaneHeaderData): Pane {
        return header.pane
    }

    paneTabBy (_index: number, tab: SessionTab): SessionTab {
        return tab
    }

    /**
     * Keeps splitter DOM stable across re-layouts so a double-click on the
     * divider isn't broken by the intermediate `layout()` rebuilding the node.
     * Keyed on the container's stable `uid` (stringifying the container itself
     * would collapse every container to "[object Object]", colliding keys of
     * different containers that share an index).
     */
    spannerBy (_index: number, spanner: SplitSpannerInfo): string {
        return `${spanner.container.uid}:${spanner.index}`
    }

    /**
     * Current pixel box of a splitter (gutter-aligned). Drives the component's
     * Inputs on each relayout so the reused (trackBy'd) spanner repositions.
     */
    spannerGeom (spanner: SplitSpannerInfo): { x: number, y: number, w: number, h: number } {
        const c = spanner.container
        const off = c.pixelOffsets[spanner.index] ?? 0
        return c.orientation === 'v'
            ? { x: c.x, y: c.y + off - SPLITTER_BAND, w: c.w, h: SPLITTER_BAND }
            : { x: c.x + off - SPLITTER_BAND, y: c.y, w: SPLITTER_BAND, h: c.h }
    }

    /**
     * Pane-tab label: a user rename wins, otherwise fall back to the stable
     * profile name rather than the dynamic (cwd/OSC) title that changes every
     * time the shell reports a new working directory.
     */
    sessionDisplayTitle (tab: SessionTab): string {
        const profileName = tab.getProfile()?.name
        return profileName ?? tab.title
    }

    isAdminSession (tab: SessionTab): boolean {
        return tab.getProfile()?.options?.runAsAdministrator === true
    }

    /**
     * Double-click a pane header (empty strip) → duplicate the pane's active session.
     */
    async duplicatePaneActiveSession (event: MouseEvent, pane: Pane): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        const active = pane.tab
        if (active) {
            await this.duplicateSession(active)
        }
    }

    /**
     * Double-click a specific session tab → duplicate just that session.
     */
    async duplicatePaneActiveTab (event: MouseEvent, _pane: Pane, tab: SessionTab): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        await this.duplicateSession(tab)
    }

    /**
     * Focuses the first available tab inside the given [[SplitContainer]]
     */
    focusAnyIn (parent?: SessionTab | SplitContainer | Pane): void {
        if (!parent) {
            return
        }
        if (parent instanceof SplitContainer) {
            this.focusAnyIn(parent.children[0])
        } else if (parent instanceof Pane) {
            this.focus(parent.tabs[parent.tabs.includes(parent.activeTab!) ? parent.tabs.indexOf(parent.activeTab!) : 0])
        } else {
            this.focus(parent)
        }
    }

    addTab (tab: SessionTab, relative: SessionTab|null, side: SplitDirection): Promise<void> {
        return this.addTabAt(tab, relative, side)
    }

    /** @hidden */
    async openPaneTabContextMenu (event: MouseEvent, tab: SessionTab): Promise<void> {
        event.preventDefault()
        // Provider sections come pre-grouped from the registry (one separator
        // between adjacent provider sections), mirroring the legacy loop.
        const actions = await this.actions.getAsync(ActionSurface.TabContext, { tab, tabHeader: true })
        let items = actionsToMenuItems(actions, { tab })

        // A session menu only shows session-level operations. Workspace-only
        // entries ("Close other workspaces", the above/below/left/right family)
        // and profile-saving must never reach the pane-tab context menu.
        // Core-provider items carry a stable id (see tabContextMenu.ts); the
        // translated-label set is a fallback for third-party providers that
        // still have no id.
        const workspaceOnlyLabels = new Set([
            this.translate.instant('Close other workspaces'),
            this.translate.instant('Close workspaces to the left'),
            this.translate.instant('Close workspaces to the right'),
            this.translate.instant('Close workspaces above'),
            this.translate.instant('Close workspaces below'),
            this.translate.instant('Save as profile'),
            this.translate.instant('Color'),
            // "create a new session" family — session menus carry no + button
            this.translate.instant('New session'),
            this.translate.instant('New admin session'),
            this.translate.instant('New with profile'),
        ])
        const workspaceOnlyIds = new Set([
            'context:close-other-workspaces',
            'context:close-workspaces-above',
            'context:close-workspaces-below',
            'context:save-layout-as-profile',
            'context:color',
        ])
        items = items.filter(item => !workspaceOnlyIds.has(item.id!) && !workspaceOnlyLabels.has(item.label!))

        // "Close" is the primary action for a session — keep it on top.
        const closeLabel = this.translate.instant('Close')
        const closeItem = items.find(item => item.label === closeLabel)
        if (closeItem && items[0] !== closeItem) {
            items = items.filter(item => item !== closeItem)
            items.unshift(closeItem)
        }

        if (items.length) {
            this.platform.popupContextMenu(items, event)
        }
    }

    /* ------------------------------------------------------------------ */
    /* Pointer-based pane-tab drag (logic lives in PaneDragController)      */
    /* ------------------------------------------------------------------ */

    /** @hidden */
    onPaneTabPointerDown (event: PointerEvent, tab: SessionTab): void {
        this.paneDrag.begin(event, tab)
    }

    /** @returns the number of panes (leaf cells) this workspace contains */
    getPaneCount (): number {
        return collectPanes(this.root).length
    }

    /**
     * Adds a session to the currently focused pane (merges it as an extra
     * sub-tab). Used when opening a new connection in an existing workspace.
     */
    async addTabToPane (tab: SessionTab): Promise<void> {
        const pane = this.focusedTab ? this.getPaneOf(this.focusedTab) : null
        if (pane) {
            if (pane.tabs.includes(tab)) {
                // The session already lives in the focused pane: just focus it,
                // never insert the same instance a second time.
                this.focus(tab)
                return
            }
            this.adoptTab(tab)
            pane.tabs.push(tab)
            pane.activeTab = tab
            await this.attachTabView(tab)
            this.focus(tab)
            this.layout()
            this.updateTitle()
            return
        }
        await this.addTabAt(tab, null, 'r')
    }

    /**
     * Duplicates a session (a sub-tab of a pane) as a new session of the SAME
     * pane. Unlike `AppService.duplicateTab` (which is only valid for top-level
     * workspaces), this keeps the copy inside the current workspace.
     */
    async duplicateSession (tab: SessionTab): Promise<SessionTab|null> {
        const dup = await this.tabsService.duplicate(tab) as SessionTab|null
        if (!dup) {
            return null
        }
        const pane = this.getPaneOf(tab)
        if (!pane) {
            dup.destroy()
            return null
        }
        this.adoptTab(dup)
        pane.tabs.push(dup)
        pane.activeTab = dup
        await this.attachTabView(dup)
        this.onAfterTabAdded(dup)
        this.recoveryStateChangedHint.next()
        return dup
    }

    /**
     * Insert a single session as a new pane at `side` of the pane hosting `relative`
     */
    async addTabAt (tab: SessionTab, relative: SessionTab|null, side: SplitDirection): Promise<void> {
        let relativeView: TabView|null = null
        if (relative) {
            relativeView = this.getPaneOf(relative)
        }
        const pane = new Pane(tab)
        await this.addPane(pane, relativeView, side)
    }

    async addPane (pane: Pane, relative: TabView|null, side: SplitDirection): Promise<void> {
        if (!relative && this.root.children.length === 0) {
            // empty sidebar: become the root pane
            this.root.children.push(pane)
            this.root.ratios.push(1)
            await this.attachPaneTabs(pane)
            this.recoveryStateChangedHint.next()
            this.layout()
            return
        }

        if (!relative) {
            // wrap the root to be able to add a sibling
            const wrapper = new SplitContainer()
            wrapper.orientation = sideDirectionOf(side)
            wrapper.children = [this.root]
            wrapper.ratios = [1]
            this.root = wrapper
            addPaneInto(this.root, pane, relative, side)
            this.recoveryStateChangedHint.next()
            await this.initialized$.toPromise()
            await this.attachPaneTabs(pane)
            this.root.normalize()
            return
        }

        const parent = this.getParentOf(relative)
        if (!parent) {
            return
        }
        addPaneInto(parent, pane, relative, side)
        await this.attachPaneTabs(pane, { skipIfAttached: true })
        this.focus(pane.tab!)
        this.layout()
        this.recoveryStateChangedHint.next()
    }

    /**
     * Attaches every tab of a freshly inserted pane to this workspace's view
     * container and runs the shared post-add hook.
     */
    private async attachPaneTabs (pane: Pane, options?: { skipIfAttached?: boolean }): Promise<void> {
        for (const tab of pane.tabs) {
            if (options?.skipIfAttached) {
                if (!this.viewRefs.has(tab)) { await this.attachTabView(tab) }
            } else {
                await this.attachTabView(tab)
            }
            this.onAfterTabAdded(tab)
        }
    }

    /** @returns the [[Pane]] containing `tab` */
    getPaneOf (tab: SessionTab, root?: SplitContainer): Pane|null {
        return findPaneForTab(root ?? this.root, tab)
    }

    removeTab (tab: SessionTab): void {
        const pane = this.getPaneOf(tab)
        if (!pane) {
            tab.destroy()
            return
        }
        pane.tabs = pane.tabs.filter(x => x !== tab)
        tab.removeFromContainer()
        tab.parent = null
        this.viewRefs.delete(tab)
        this.tabRemoved.next(tab)

        if (pane.activeTab === tab) {
            pane.activeTab = pane.tabs[0] ?? null
        }
        this.cleanRoot()
        this.updateTitle()
    }

    /**
     * Demo-style cleanup: remove empty panes and collapse containers with a
     * single effective child. Call after any tree mutation.
     */
    cleanRoot (): void {
        let cleaned = cleanNode(this.root)
        if (cleaned instanceof Pane) {
            const wrap = new SplitContainer()
            wrap.children = [cleaned]
            wrap.ratios = [1]
            cleaned = wrap
        }
        this.root = cleaned instanceof SplitContainer ? cleaned : new SplitContainer()
        this.layout()
        if (this.getAllTabs().length === 0) {
            this.destroy()
        } else if (!this.focusedTab || !this.getAllTabs().includes(this.focusedTab)) {
            this.focusAnyIn(this.root)
        }
    }

    replaceTab (tab: BaseTabComponent, newTab: BaseTabComponent): void {
        const pane = this.getPaneOf(tab)
        if (pane) {
            const position = pane.tabs.indexOf(tab)
            if (position < 0) { return }
            tab.removeFromContainer()
            this.adoptTab(newTab)
            pane.tabs[position] = newTab
            if (pane.activeTab === tab) { pane.activeTab = newTab }
            this.attachTabView(newTab)
            this.onAfterTabAdded(newTab)
            this.recoveryStateChangedHint.next()
            this.updateTitle()
        }
    }

    async splitTab (tab: SessionTab, dir: SplitDirection): Promise<SessionTab|null> {
        const newTab = await this.tabsService.duplicate(tab) as SessionTab|null
        if (newTab) {
            await this.addTabAt(newTab, tab, dir)
        }
        return newTab
    }

    /**
     * @returns the immediate parent split container of `target`
     */
    getParentOf (target: SessionTab | TabView, root?: SplitContainer): SplitContainer|null {
        return findParentContainer(root ?? this.root, target)
    }

    /** @hidden */
    async canClose (): Promise<boolean> {
        return !(await Promise.all(this.getAllTabs().map(x => x.canClose()))).some(x => !x)
    }

    /** @hidden */
    async getRecoveryToken (options?: GetRecoveryTokenOptions): Promise<any> {
        const token = await this.root.serialize(this.tabRecovery, options)
        // Persist the workspace-owned colour so an empty or later-recreated
        // workspace keeps its colour across restarts.
        token.color = this.color ?? undefined
        return token
    }

    /** @hidden */
    async getCurrentProcess (): Promise<BaseTabProcess|null> {
        return (await Promise.all(this.getAllTabs().map(x => x.getCurrentProcess()))).find(x => !!x) ?? null
    }

    /** @hidden */
    onSpannerAdjusted (spanner: SplitSpannerInfo): void {
        this.layout()
        this.splitAdjusted.next(spanner)
    }

    /** @hidden */
    onSpannerResizing (state: boolean): void {
        this._spannerResizing = state
        this._pixelResizing = state
    }

    /** @hidden */
    onTabDropped (tab: BaseTabComponent, zone: SplitDropZoneInfo) { // eslint-disable-line @typescript-eslint/explicit-module-boundary-types
        if (tab === this) { return }
        if (!(tab instanceof SessionTab)) {
            // Only a session (a running connection) may be moved into this
            // workspace's panes. Every other top-level tab — other workspaces,
            // settings, welcome, release notes — must never be nested as a pane
            // sub-tab (it would end up rendered inside the pane's title bar).
            return
        }
        const session = tab

        if (zone.type === 'center') {
            this.dropTabInto(session, { pane: zone.pane, side: 'all' })
        } else {
            const relativeRef = zone.relativeTo
            const relativeTab = resolveRelativeTab(relativeRef as TabView | SessionTab, session)
            this.dropTabInto(session, { pane: null, relativeTab, side: zone.side })
        }
        this.tabAdopted.next(tab)
    }

    /**
     * Moves a pane session into another pane (side 'all' → merge into
     * `target.pane`) or into a freshly-created pane at `side` (split, relative
     * to `relativeTab`), removing it from its source pane first. Single shared
     * implementation for the pointer drag gesture (commitDrag) and the native
     * drop zones (onTabDropped).
     */
    dropTabInto (tab: SessionTab, target: { pane: Pane|null, side: SplitDirection|'all', relativeTab?: SessionTab|null }): void {
        const sourcePane = this.getPaneOf(tab)
        if (target.side === 'all') {
            if (!target.pane || sourcePane === target.pane) { return }
            this.removeTabFromPane(sourcePane, tab)
            target.pane.tabs.push(tab)
            target.pane.activeTab = tab
            this.focus(tab)
            this.cleanRoot()
        } else {
            const relativeTab = target.relativeTab ?? target.pane?.tabs[0] ?? null
            this.removeTabFromPane(sourcePane, tab)
            void this.addTabAt(tab, relativeTab, target.side)
            this.cleanRoot()
        }
    }

    /**
     * Detach a tab from its current pane without tearing down its view.
     * Sane for pane-to-pane moves within the same split.
     */
    removeTabFromPane (pane: Pane|null, tab: SessionTab): void {
        if (!pane) { return }
        const idx = pane.tabs.indexOf(tab)
        if (idx < 0) { return }
        pane.tabs.splice(idx, 1)
        if (pane.activeTab === tab) {
            pane.activeTab = pane.tabs[Math.min(idx, pane.tabs.length - 1)] ?? null
        }
    }

    /** @hidden PaneDragHost */
    workspaceTargetAt (x: number, y: number): { workspace: WorkspaceComponent, rect: DOMRect } | null {
        // Only the focused workspace's panes are visible, so another workspace
        // is reachable through its top-level tab header in the tab bar. Match
        // headers to tabs by DOM order (the tab bar renders one `tab-header`
        // per entry of `AppService.tabs`, in order).
        const tabs = this.app.tabs
        const headers = document.querySelectorAll('tab-header')
        if (headers.length !== tabs.length) {
            // The renderer may lag a freshly added/removed tab — skip rather
            // than mis-map.
            return null
        }
        for (let i = 0; i < tabs.length; i++) {
            const tab = tabs[i]
            if (tab === this || !(tab instanceof WorkspaceComponent)) {
                continue
            }
            const rect = (headers[i] as HTMLElement).getBoundingClientRect()
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                return { workspace: tab, rect }
            }
        }
        return null
    }

    /** @hidden PaneDragHost */
    async moveSessionToWorkspace (tab: SessionTab, target: WorkspaceComponent): Promise<void> {
        if (target === this || tab.parent !== this) {
            return
        }
        const pane = this.getPaneOf(tab)
        if (!pane) {
            return
        }
        // Detach the session's view without destroying it.
        pane.tabs = pane.tabs.filter(x => x !== tab)
        if (pane.activeTab === tab) {
            pane.activeTab = pane.tabs[0] ?? null
        }
        tab.removeFromContainer()
        tab.parent = null
        this.viewRefs.delete(tab)
        this.tabRemoved.next(tab)
        this.updateTitle()

        // Re-home it into the target workspace (focused pane, or a new pane if
        // the target is empty), then bring that workspace to the front.
        await target.addTabToPane(tab)
        if (this.app.activeTab !== target) {
            this.app.selectTab(target)
        }
        // Collapse the source tree — if it ended up empty it closes itself,
        // matching the remove-last-tab flow.
        this.cleanRoot()
    }

    /**
     * When a session drag crosses this window's bounds: capture its recovery
     * token (with the live PTY id) while the session is still alive and hand
     * control to the main process, which routes the cursor to other windows.
     */
    beginCrossWindowDrag (tab: SessionTab): void {
        this.crossWindowArmId++
        const session = (tab as any).session
        if (session && typeof session.keepPTYAlive === 'boolean') {
            // The target window will restore this session from its PTY id; the
            // source session must not kill the underlying PTY when detached.
            session.keepPTYAlive = true
        }
        // Drag card first, synchronously: the main process holds it until the
        // (slower, async) token serialization finishes and the drag starts.
        // Use the same text the tab header shows (profile name fallback).
        this.hostApp.windowDragCard({
            title: tab.customTitle || tab.getProfile()?.name || tab.title,
            color: null,
        })
        void this.tabRecovery.getFullRecoveryToken(tab, { includeState: true })
            .then(token => {
                if (token) {
                    this.hostApp.windowDragStart('session', token)
                }
            })
            .catch(err => console.error('[workspace] cross-window drag token failed:', err))
    }

    /**
     * The pointer was released mid cross-window drag. The main process decides
     * the target window; we stay parked until it reports committed/cancelled.
     */
    endCrossWindowDrag (tab: SessionTab): void {
        const armId = this.crossWindowArmId
        const session = (tab as any).session
        let done = false
        const sub = this.hostApp.windowDragCommitted$.subscribe(() => {
            if (done || this.crossWindowArmId !== armId) { return }
            done = true
            sub.unsubscribe()
            if (session && typeof session.keepPTYAlive === 'boolean') {
                // Session now lives in the other window (its PTY was restored
                // there); drop our detached copy without touching the PTY.
                session.keepPTYAlive = true
            }
            this.removeSessionView(tab)
            this.cleanRoot()
        })
        this.hostApp.windowDragCancelled$.subscribe(() => {
            if (done || this.crossWindowArmId !== armId) { return }
            done = true
            sub.unsubscribe()
            // The drag landed on nothing — the session stays here, and its
            // PTY must be killable again if the user closes it normally.
            if (session && typeof session.keepPTYAlive === 'boolean') {
                session.keepPTYAlive = false
            }
        })
        this.hostApp.windowDragEnd()
    }

    /**
     * The pointer re-entered this window while a cross-window drag was in
     * flight — cancel the protocol (drop the ghost, undoes keep-alives) so the
     * tab can be moved inside this workspace again.
     */
    reenterCrossWindowDrag (tab: SessionTab): void {
        this.crossWindowArmId++
        const session = (tab as any).session
        if (session && typeof session.keepPTYAlive === 'boolean') {
            session.keepPTYAlive = false
        }
        this.hostApp.windowDragCancel()
    }

    private removeSessionView (tab: SessionTab): void {
        const pane = this.getPaneOf(tab)
        if (pane) {
            pane.tabs = pane.tabs.filter(x => x !== tab)
            if (pane.activeTab === tab) {
                pane.activeTab = pane.tabs[0] ?? null
            }
        }
        if (tab.parent) {
            tab.removeFromContainer()
            tab.parent = null
        }
        this.viewRefs.delete(tab)
        this.tabRemoved.next(tab)
        this.layout()
        this.updateTitle()
    }

    destroy (): void {
        for (const x of this.getAllTabs()) {
            // Only destroy sub-tabs still attached to the view; tabs already
            // detached by `removeTab` must not be destroyed a second time.
            if (this.viewRefs.has(x)) { x.destroy() }
        }
        super.destroy()
    }

    layout (): void {
        this.root.normalize()
        this.isEmpty = this.root.children.length === 0

        const host = this.hostElement()
        if (host) {
            const w = host.clientWidth
            const h = host.clientHeight
            if (w > 0 || h > 0) {
                this._canvasW = w
                this._canvasH = h
            }
        }

        const recreate = !this._pixelResizing
        if (recreate) {
            this._spanners = []
            this._dropZones = []
            this._paneHeaders = []
        }

        const result = layoutTree(this.root, 0, 0, this._canvasW, this._canvasH, this.paneHeaderHeight, recreate)
        if (recreate) {
            // Layout-derived view data in the exact recursive order the template expects.
            this._spanners = result.spanners
            this._dropZones = result.dropZones
            this._paneHeaders = result.paneHeaders
        }

        // Even mid-pixel-resize the tab DOM must follow the new geometry.
        for (const placement of result.placements) {
            this.positionPane(placement)
        }
    }

    /** Positions one pane's session DOM under its header strip. */
    private positionPane (placement: PanePlacement): void {
        const activeTab = placement.pane.tab
        for (const tab of placement.pane.tabs) {
            const viewRef = this.viewRefs.get(tab)
            if (!viewRef) { continue }
            const element = viewRef.rootNodes[0]
            const isActive = tab === activeTab
            element.classList.add('child')
            element.classList.add('pane-tab-view')
            element.classList.toggle('pane-tab-inactive', !isActive)
            element.classList.toggle('focused', isActive)
            element.style.left = `${placement.x}px`
            element.style.top = `${placement.y + this.paneHeaderHeight}px`
            element.style.width = `${placement.w}px`
            element.style.height = `${Math.max(placement.h - this.paneHeaderHeight, 0)}px`
        }
    }

    clearActivity (): void {
        for (const tab of this.getAllTabs()) { tab.clearActivity() }
        super.clearActivity()
    }

    get icon (): string|null {
        return this._workspaceIcon ?? WorkspaceComponent.workspaceIcon
    }

    set icon (icon: string|null) {
        this._workspaceIcon = icon
    }

    equalize (): void {
        this.root.normalize()
        this.root.equalize()
    }

    private updateTitle (): void {
        if (this.disableDynamicTitle) { return }
        if (this.customTitle) { return }
        // A workspace created from a saved layout keeps the profile's name.
        if (this._profileName) {
            this.setTitle(this._profileName)
            return
        }
        // Session-restored workspace keeps the title it had before the restart.
        if (this._recoveredTitle) {
            this.setTitle(this._recoveredTitle)
            return
        }
        // Workspace names are stable: they only change when the user renames
        // them. Don't auto-derive from (or overwrite with) child session titles.
        this.setTitle(this.translate.instant('Untitled workspace'))
    }

    private adoptTab (tab: SessionTab): void {
        if (tab.parent instanceof WorkspaceComponent) { tab.parent.removeTab(tab) }
        tab.removeFromContainer()
        tab.pinned = false // sessions never participate in pinning
        tab.parent = this
        tab.emitVisibility(this.visibility.value)
    }

    private async attachTabView (tab: SessionTab) {
        // Defensive: @ViewChild is null until the view is initialised; the type
        // doesn't reflect that.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!this.viewContainer) {
            // The tab view is only available after the component's view is
            // initialised; a session may be created before that (e.g. right when
            // a brand-new workspace is opened from the profile list).
            await this.initialized$.toPromise()
        }
        if (this.viewRefs.has(tab)) {
            // already attached; do not double-insert the same host view
            return
        }
        // Every session that gets its view attached here belongs to this
        // workspace. Setting the parent in this single choke point covers all
        // add paths (first session / split / recovery / cross-workspace move);
        // session consumers rely on `parent` (context menus, switch-profile,
        // cross-workspace drag guard).
        tab.parent = this
        const ref = tab.insertIntoContainer(this.viewContainer)
        this.viewRefs.set(tab, ref)
        tab.addEventListenerUntilDestroyed(ref.rootNodes[0], 'click', () => {
            // Guard: the session may have been moved to another workspace, in
            // which case this workspace must not claim focus on its behalf.
            if (this.getAllTabs().includes(tab)) { this.focus(tab) }
        })
        if (this.config.store.terminal.focusFollowsMouse) {
            tab.addEventListenerUntilDestroyed(ref.rootNodes[0], 'mousemove', () => {
                if (this._spannerResizing || !this.getAllTabs().includes(tab)) { return }
                this.focus(tab)
            })
        }

        tab.subscribeUntilDestroyed(this.observeUntilChildDetached(tab, tab.focused$), () => this.updateTitle())
        tab.subscribeUntilDestroyed(this.observeUntilChildDetached(tab, tab.titleChange$), () => this.updateTitle())
        tab.subscribeUntilDestroyed(this.observeUntilChildDetached(tab, tab.activity$), a => a ? this.displayActivity() : this.clearActivity())
        tab.subscribeUntilDestroyed(this.observeUntilChildDetached(tab, tab.progress$), p => this.setProgress(p))
        if (tab.title) { this.updateTitle() }
        tab.subscribeUntilDestroyed(
            this.observeUntilChildDetached(tab, tab.recoveryStateChangedHint$),
            () => this.recoveryStateChangedHint.next(),
        )
        tab.destroyed$.subscribe(() => this.removeTab(tab))
    }

    private observeUntilChildDetached<T> (tab: SessionTab, event: Observable<T>): Observable<T> {
        return event.pipe(takeWhile(() => this.getAllTabs().includes(tab)))
    }

    private onAfterTabAdded (tab: SessionTab) {
        setImmediate(() => {
            this.layout()
            this.tabAdded.next(tab)
            this.focus(tab)
        })
    }

    private async recoverContainer (root: SplitContainer, state: any) {
        const children: (SplitContainer | Pane)[] = []
        root.orientation = state.orientation
        root.ratios = state.ratios
        root.children = children
        for (const childState of state.children) {
            if (!childState) { continue }
            if (childState.type === 'app:split-tab') {
                const child = new SplitContainer()
                await this.recoverContainer(child, childState)
                children.push(child)
            } else if (childState.type === 'app:split-tab-pane') {
                const pane = new Pane()
                for (const tabState of childState.tabs ?? []) {
                    const recovered = await this.tabRecovery.recoverTab(tabState)
                    if (recovered) {
                        // Recovery only ever recreates session tabs.
                        const tab = this.tabsService.create(recovered) as SessionTab
                        tab.pinned = false
                        pane.tabs.push(tab)
                        tab.parent = this
                        await this.attachTabView(tab)
                    }
                }
                pane.activeTab = pane.tabs[Math.min(Math.max(0, childState.active ?? 0), pane.tabs.length - 1)] ?? null
                children.push(pane)
            } else {
                // legacy: plain tab token → wrap into a single-tab pane
                const recovered = await this.tabRecovery.recoverTab(childState)
                if (recovered) {
                    // Recovery only ever recreates session tabs.
                    const tab = this.tabsService.create(recovered) as SessionTab
                    tab.pinned = false
                    const pane = new Pane(tab)
                    children.push(pane)
                    tab.parent = this
                    await this.attachTabView(tab)
                } else {
                    state.ratios.splice(state.children.indexOf(childState), 1)
                }
            }
        }
        while (root.ratios.length < root.children.length) {
            root.ratios.push(1)
        }
        root.normalize()
    }
}

/**
 * @deprecated Renamed to {@link WorkspaceComponent}. Kept so existing plugins
 * that reference the old class keep compiling (and `instanceof` keeps working).
 */
export const SplitTabComponent = WorkspaceComponent

/** @hidden */
@Injectable({ providedIn: 'root' })
export class SplitTabRecoveryProvider extends TabRecoveryProvider<WorkspaceComponent> {
    async applicableTo (recoveryToken: RecoveryToken): Promise<boolean> {
        return recoveryToken.type === 'app:split-tab'
    }

    async recover (recoveryToken: RecoveryToken): Promise<NewTabParameters<WorkspaceComponent>> {
        return {
            type: WorkspaceComponent,
            inputs: {
                _recoveredState: recoveryToken,
                _recoveredTitle: (recoveryToken as any).tabTitle ?? null,
                _recoveredColor: (recoveryToken as any).color ?? null,
            },
        }
    }
}
