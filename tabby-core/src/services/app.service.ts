import { Injectable, Inject } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { Observable, Subject, AsyncSubject, takeUntil, debounceTime } from 'rxjs'

import { BaseTabComponent } from '../components/baseTab.component'
import { WorkspaceComponent } from '../components/workspace.component'
import { Pane, SplitDirection } from '../components/workspace.layout'
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

    /** The workspace whose tab header is currently hovered by the drag. */
    crossWindowDragTarget: { workspace: WorkspaceComponent, zone: { pane: Pane, side: SplitDirection|'all' }|null }|null = null

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

        // Cross-window drag targeting this window: track a hovered workspace
        // (its tab header in the tab bar) and, on drop, restore the dragged
        // session into that workspace.
        this.hostApp.windowDragMove$.subscribe(({ x, y }) => {
            this.crossWindowDragTarget = this.crossWindowDropTargetAt(
                x - window.screenX,
                y - window.screenY,
            )
        })

        this.hostApp.windowDragEnter$.subscribe(() => {
            this.clearCrossWindowDragTarget()
        })

        this.hostApp.windowDragLeave$.subscribe(() => {
            this.clearCrossWindowDragTarget()
        })

        this.hostApp.windowDragCommit$.subscribe(async ({ token }) => {
            const target = this.crossWindowDragTarget ?? (
                this._activeTab instanceof WorkspaceComponent ? { workspace: this._activeTab, zone: null } : null
            )
            this.clearCrossWindowDragTarget()
            try {
                const params = await this.tabRecovery.recoverTab(token)
                if (!params) {
                    this.hostApp.windowDragAccepted()
                    return
                }
                if (target?.workspace && params?.type.prototype instanceof SessionTab) {
                    // Re-home the restored session into the hovered workspace.
                    const session = this.tabsService.create(params as NewTabParameters<SessionTab>)
                    this.selectTab(target.workspace)
                    if (target.zone) {
                        // Drop landed on a precise pane edge/center — insert at
                        // the exact cursor location (merge or split).
                        await target.workspace.addSessionAt(session, target.zone)
                    } else {
                        await target.workspace.addTabToPane(session)
                    }
                } else {
                    this.openNewTabRaw(params as any)
                }
                this.hostApp.windowDragAccepted()
            } catch (err) {
                console.error('[app] cross-window drop failed:', err)
                this.hostApp.windowDragAccepted()
            }
        })

        this.tabClosed$.subscribe(() => {
            if (!this.tabs.length && this.config.store.appearance.lastTabClosesWindow) {
                this.hostWindow.close()
            }
        })

        hostWindow.windowFocused$.subscribe(() => this._activeTab?.emitFocused())
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
        const session = tab as SessionTab
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
                if (topLevelTab.getAllTabs().includes(tab)) {
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
            ? tab.parent.sessionDisplayTitle(tab)
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
     * Cross-window drop target under a local (client) point. Resolves to the
     * precise pane/edge of the focused workspace when the cursor is over its
     * panes (so the dragged session can be merged/split at the exact drop
     * point), otherwise to the workspace whose tab header is hovered.
     */
    crossWindowDropTargetAt (x: number, y: number): { workspace: WorkspaceComponent, zone: { pane: Pane, side: SplitDirection|'all' }|null }|null {
        const active = this._activeTab
        if (active instanceof WorkspaceComponent) {
            // Only the focused workspace's panes are rendered, so precise
            // pane-level targeting applies to it.
            const zone = active.dropZoneAt(x, y)
            if (zone) {
                active.showDropHintAt(x, y)
                return { workspace: active, zone }
            }
            // Not over a pane — keep the hint in sync (it may still highlight
            // another workspace's tab header via the workspace-target fallback).
            active.showDropHintAt(x, y)
        }
        const workspace = this.findWorkspaceAt(x, y)
        if (workspace) {
            return { workspace, zone: null }
        }
        return null
    }

    clearCrossWindowDragTarget (): void {
        this.crossWindowDragTarget = null
        if (this._activeTab instanceof WorkspaceComponent) {
            this._activeTab.setDragHint(null)
        }
    }

    /**
     * The workspace (of this window) whose top-level tab header covers a local
     * point — the cross-window drop target.
     */
    findWorkspaceAt (x: number, y: number): WorkspaceComponent|null {
        // Map tab headers to tabs by DOM order: the tab bar renders one
        // `tab-header` per entry of `AppService.tabs`, in the same order.
        const headers = document.querySelectorAll('tab-header')
        if (headers.length !== this.tabs.length) {
            return null
        }
        for (let i = 0; i < this.tabs.length; i++) {
            const tab = this.tabs[i]
            if (!(tab instanceof WorkspaceComponent)) {
                continue
            }
            const rect = (headers[i] as HTMLElement).getBoundingClientRect()
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                return tab
            }
        }
        return null
    }

    /**
     * Cross-window workspace drag (source side): capture the token while the
     * sessions are alive, arm the PTY-keepalive, request a ghost thumbnail and
     * start the main-process drag protocol. The outcome is handled by
     * `endWorkspaceCrossWindowDrag`.
     */
    async startWorkspaceCrossWindowDrag (tab: WorkspaceComponent, ifActive?: () => boolean): Promise<void> {
        // Drag card first, synchronously: the main process caches it until the
        // (slower, async) token serialization finishes and the drag starts.
        this.hostApp.windowDragCard({ title: tab.customTitle || tab.title, color: null })
        const token = await this.tabRecovery.getFullRecoveryToken(tab, { includeState: true })
        if (!token) {
            return
        }
        // The user may have dragged back into the window while we serialized —
        // don't start a stale protocol in that case.
        if (ifActive && !ifActive()) {
            this.hostApp.windowDragCancel()
            return
        }
        const transferToken = JSON.parse(JSON.stringify(token))
        for (const s of tab.getAllTabs()) {
            const session = (s as any).session
            if (session?.keepPTYAlive !== undefined) {
                session.keepPTYAlive = true
            }
        }
        this.hostApp.windowDragStart('workspace', transferToken)
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
     * Cross-window workspace drag (source side): pointer released — the main
     * process commits the drop to the window under the cursor. Once its
     * renderer rebuilt the workspace it signals `drag-committed`, at which
     * point we drop our copy. A cancelled drop (landed outside every window)
     * opens the workspace in a brand-new window — the old drag-out behaviour.
     */
    endWorkspaceCrossWindowDrag (tab: WorkspaceComponent): void {
        let done = false
        const commitSub = this.hostApp.windowDragCommitted$.subscribe(() => {
            if (done) { return }
            done = true
            commitSub.unsubscribe()
            cancelSub.unsubscribe()
            this.removeTab(tab)
            this.maybeCloseWindowWhenEmpty()
        })
        const cancelSub = this.hostApp.windowDragCancelled$.subscribe(() => {
            if (done) { return }
            done = true
            commitSub.unsubscribe()
            cancelSub.unsubscribe()
            // Dropped on nothing → open it in a brand-new window (kept alive).
            this.moveWorkspaceToWindow(tab)
        })
        this.hostApp.windowDragEnd()
    }

    /**
     * Source side: the drag was aborted because the pointer re-entered this
     * window — cancel the protocol, restore the PTY keep-alives and let the
     * native CDK reorder resume.
     */
    cancelWorkspaceCrossWindowDrag (tab: WorkspaceComponent): void {
        for (const s of tab.getAllTabs()) {
            const session = (s as any).session
            if (session && typeof session.keepPTYAlive === 'boolean') {
                session.keepPTYAlive = false
            }
        }
        this.hostApp.windowDragCancel()
    }

    /**
     * Moves a workspace out of this window into another (existing or new)
     * window. Serializes the workspace (PTY ids included), detaches its
     * sessions without killing the underlying PTYs, then asks the host to open
     * it in the target window which re-attaches the live pty.
     */
    async moveWorkspaceToWindow (tab: WorkspaceComponent, screenPoint?: { x: number, y: number }): Promise<void> {
        const token = await this.tabRecovery.getFullRecoveryToken(tab, { includeState: true })
        if (!token) {
            return
        }
        // IPC cannot clone arbitrary objects — send a plain JSON copy.
        const transferToken = JSON.parse(JSON.stringify(token))
        for (const s of tab.getAllTabs()) {
            const session = (s as any).session
            if (session?.keepPTYAlive !== undefined) {
                session.keepPTYAlive = true
            }
        }
        this.removeTab(tab)
        this.maybeCloseWindowWhenEmpty()
        this.hostApp.newWindow({
            recoveryToken: transferToken,
            x: screenPoint?.x,
            y: screenPoint?.y,
        })
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
