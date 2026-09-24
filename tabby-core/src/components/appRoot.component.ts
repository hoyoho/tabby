/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Input, HostListener, HostBinding, ViewChildren, ViewChild, Optional, ElementRef } from '@angular/core'
import { trigger, style, animate, transition, state } from '@angular/animations'
import { NgbDropdown, NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { CdkDragDrop } from '@angular/cdk/drag-drop'

import { HostAppService, Platform } from '../api/hostApp'
import { HotkeysService } from '../services/hotkeys.service'
import { Logger, LogService } from '../services/log.service'
import { ConfigService } from '../services/config.service'
import { ThemesService } from '../services/themes.service'
import { CommandService } from '../services/commands.service'

import { BaseTabComponent } from './baseTab.component'
import { SafeModeModalComponent } from './safeModeModal.component'
import { TabBodyComponent } from './tabBody.component'
import { WorkspaceComponent } from './workspace.component'
import {
    AppService,
    Command,
    CommandLocation,
    FileTransfer,
    HostWindowService,
    PlatformService,
    ActionSurface,
    DockingService,
} from '../api'
import { ActionRegistry } from '../services/action.service'

function makeTabAnimation (dimension: string, size: number) {
    return [
        state('in', style({
            'flex-basis': '{{size}}',
            [dimension]: '{{size}}',
        }), {
            params: { size: `${size}px` },
        }),
        transition(':enter', [
            style({
                'flex-basis': '1px',
                [dimension]: '1px',
            }),
            animate('250ms ease-out', style({
                'flex-basis': '{{size}}',
                [dimension]: '{{size}}',
            })),
        ]),
        transition(':leave', [
            style({
                'flex-basis': 'auto',
                'padding-left': '*',
                'padding-right': '*',
                [dimension]: '*',
            }),
            animate('250ms ease-in-out', style({
                'padding-left': 0,
                'padding-right': 0,
                [dimension]: '0',
            })),
        ]),
    ]
}

/** @hidden */
@Component({
    selector: 'app-root',
    templateUrl: './appRoot.component.pug',
    styleUrls: ['./appRoot.component.scss'],
    animations: [
        trigger('animateTab', makeTabAnimation('width', 200)),
    ],
})
export class AppRootComponent {
    Platform = Platform
    @Input() ready = false
    @Input() leftToolbarButtons: Command[]
    @Input() rightToolbarButtons: Command[]
    @HostBinding('class.platform-win32') platformClassWindows = process.platform === 'win32'
    @HostBinding('class.platform-darwin') platformClassMacOS = process.platform === 'darwin'
    @HostBinding('class.platform-linux') platformClassLinux = process.platform === 'linux'
    @HostBinding('class.no-tabs') noTabs = true
    @ViewChildren(TabBodyComponent) tabBodies: TabBodyComponent[]
    @ViewChild('activeTransfersDropdown') activeTransfersDropdown: NgbDropdown
    /** @hidden scrollable top-level tab strip (horizontal layout only) */
    @ViewChild('tabsScroll') tabsScroll?: ElementRef<HTMLElement>
    /** @hidden whether the top-level tab strip overflows (arrows shown) */
    tabsOverflowing = false
    /** @hidden timestamp of the most recent tab removal; used to swallow the
     *  second click of a double-click on a tab's close button, which would
     *  otherwise land on the tab bar and toggle window maximize. */
    private lastTabRemovedAt = 0
    unsortedTabs: BaseTabComponent[] = []
    activeTransfers: FileTransfer[] = []
    private logger: Logger

    constructor (
        private hotkeys: HotkeysService,
        private commands: CommandService,
        private actions: ActionRegistry,
        public hostWindow: HostWindowService,
        public hostApp: HostAppService,
        public config: ConfigService,
        public app: AppService,
        platform: PlatformService,
        log: LogService,
        ngbModal: NgbModal,
        _themes: ThemesService,
        @Optional() private docking?: DockingService,
    ) {
        // document.querySelector('app-root')?.remove()
        this.logger = log.create('main')
        this.logger.info('v', platform.getAppVersion())

        this.hotkeys.hotkey$.subscribe((hotkey: string) => {
            if (hotkey.startsWith('tab-')) {
                const index = parseInt(hotkey.split('-')[1])
                if (index <= this.app.tabs.length) {
                    this.app.selectTab(this.app.tabs[index - 1])
                }
            }
            if (this.app.activeTab) {
                if (hotkey === 'close-tab') {
                    this.app.closeTab(this.app.activeTab, true)
                }
                if (hotkey === 'toggle-last-tab') {
                    this.app.toggleLastTab()
                }
                if (hotkey === 'next-tab') {
                    this.app.nextTab()
                }
                if (hotkey === 'previous-tab') {
                    this.app.previousTab()
                }
                if (hotkey === 'move-tab-left') {
                    this.app.moveSelectedTabLeft()
                }
                if (hotkey === 'move-tab-right') {
                    this.app.moveSelectedTabRight()
                }
                if (hotkey === 'duplicate-tab') {
                    this.app.duplicateTab(this.app.activeTab)
                }
                if (hotkey === 'pin-tab') {
                    this.app.toggleTabPinned(this.app.activeTab)
                }
                if (hotkey === 'restart-tab') {
                    this.app.restartTab(this.app.activeTab)
                }
                if (hotkey === 'explode-tab' && this.app.activeTab instanceof WorkspaceComponent) {
                    this.app.explodeTab(this.app.activeTab)
                }
                if (hotkey === 'combine-tabs' && this.app.activeTab instanceof WorkspaceComponent) {
                    void this.app.combineTabsInto(this.app.activeTab)
                }
            }
            if (hotkey === 'reopen-tab') {
                this.app.reopenLastTab()
            }
            if (hotkey === 'toggle-fullscreen') {
                hostWindow.toggleFullscreen()
            }
            if (hotkey === 'toggle-profile-tree') {
                this.config.store.showProfileTree = !this.config.store.showProfileTree
                this.config.save()
            }
        })

        this.hostWindow.windowCloseRequest$.subscribe(async () => {
            this.app.closeWindow()
        })

        if (window['safeModeReason']) {
            ngbModal.open(SafeModeModalComponent)
        }

        this.app.tabOpened$.subscribe(tab => {
            this.unsortedTabs.push(tab)
            this.noTabs = false
            this.app.emitTabDragEnded()
            this.scheduleTabsOverflowUpdate()
            // A newly opened tab is appended (or inserted) and selected; if the
            // strip overflows it may land off-screen, so scroll it into view.
            this.scheduleScrollActiveTabIntoView()
        })

        this.app.tabRemoved$.subscribe(tab => {
            for (const tabBody of this.tabBodies) {
                if (tabBody.tab === tab) {
                    tabBody.detach()
                }
            }
            this.unsortedTabs = this.unsortedTabs.filter(x => x !== tab)
            this.noTabs = app.tabs.length === 0
            this.app.emitTabDragEnded()
            this.scheduleTabsOverflowUpdate()
        })

        platform.fileTransferStarted$.subscribe(transfer => {
            this.activeTransfers.push(transfer)
            this.activeTransfersDropdown.open()
        })

        config.ready$.toPromise().then(async () => {
            this.leftToolbarButtons = await this.getToolbarButtons(false)
            this.rightToolbarButtons = await this.getToolbarButtons(true)
        })
    }

    async ngOnInit () {
        this.config.ready$.toPromise().then(() => {
            this.ready = true
            this.app.emitReady()
        })

        // While the window is being dragged, suppress the split-pane layout
        // transition (see workspace.component.scss). Animating pane geometry on
        // every resize frame triggers a full-layer repaint that flickers the
        // terminal; the transition is only wanted for split/close/maximize.
        let resizeEndTimeout: any = null
        window.addEventListener('resize', () => {
            document.body.classList.add('resizing')
            this.scheduleTabsOverflowUpdate()
            if (resizeEndTimeout) {
                clearTimeout(resizeEndTimeout)
            }
            resizeEndTimeout = setTimeout(() => {
                document.body.classList.remove('resizing')
                this.updateTabsOverflow()
            }, 200)
        })

        // Switching flexTabs or tabsLocation changes tab widths and can flip
        // the overflow state.
        this.config.changed$.subscribe(() => this.scheduleTabsOverflowUpdate())
    }

    @HostListener('dragover')
    onDragOver () {
        return false
    }

    @HostListener('drop')
    onDrop () {
        return false
    }

    hasVerticalTabs () {
        return this.config.store.appearance.tabsLocation === 'left' || this.config.store.appearance.tabsLocation === 'right'
    }

    get targetTabSize (): any {
        if (this.hasVerticalTabs()) {
            return '*'
        }
        return this.config.store.appearance.flexTabs ? '*' : '200px'
    }

    /**
     * @hidden Measures the top-level tab strip and flips `tabsOverflowing`
     * when the tabs don't fit in the visible width. No-op for vertical tab
     * layouts (those already scroll via the .tab-bar's overflow-y).
     */
    updateTabsOverflow (): void {
        if (this.hasVerticalTabs()) {
            this.tabsOverflowing = false
            return
        }
        const el = this.tabsScroll?.nativeElement
        if (!el) { return }
        this.tabsOverflowing = el.scrollWidth > el.clientWidth + 1
    }

    /** @hidden Schedules an overflow measurement after the next paint. */
    private scheduleTabsOverflowUpdate (): void {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => this.updateTabsOverflow())
        })
    }

    /**
     * @hidden Scrolls the top-level tab strip left (-1) or right (+1) by
     * roughly one visible page.
     */
    scrollTabs (direction: number): void {
        const el = this.tabsScroll?.nativeElement
        if (!el) { return }
        const amount = Math.max(el.clientWidth * 0.8, 120)
        el.scrollBy({ left: direction * amount, behavior: 'smooth' })
    }

    /**
     * @hidden Scrolls the top-level tab strip horizontally so the active tab
     * header is visible. Used when a new workspace (or any top-level tab) is
     * appended while the strip overflows — otherwise the freshly selected tab
     * can land off-screen to the right.
     */
    scrollActiveTabIntoView (): void {
        if (this.hasVerticalTabs()) { return }
        const el = this.tabsScroll?.nativeElement
        if (!el) { return }
        const active = el.querySelector('tab-header.active')
        if (!active) { return }
        const elRect = el.getBoundingClientRect()
        const tabRect = active.getBoundingClientRect()
        const pad = 8
        if (tabRect.left < elRect.left) {
            el.scrollLeft -= elRect.left - tabRect.left + pad
        } else if (tabRect.right > elRect.right) {
            el.scrollLeft += tabRect.right - elRect.right + pad
        }
    }

    /** @hidden Scrolls the active tab into view after the next paint, so the
     *  just-added tab header exists in the DOM. Also schedules a follow-up
     *  pass after the `:enter` width animation (250ms) has settled — the first
     *  pass measures the tab mid-grow and would only scroll far enough to show
     *  its current (narrow) width, leaving the final 200px tab half-hidden. */
    private scheduleScrollActiveTabIntoView (): void {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => this.scrollActiveTabIntoView())
        })
        // The workspace tab `:enter` animation grows width 1px → 200px over
        // 250ms; re-measure once it has settled so the full tab lands in view.
        window.setTimeout(() => this.scrollActiveTabIntoView(), 280)
    }

    onTabsReordered (event: CdkDragDrop<BaseTabComponent[]>) {
        // Only workspace/settings/… top-level tab headers are CDK drag sources;
        // a session dragged between workspaces goes through the pane drag
        // controller instead, so the reordered item is always in `tabs`.
        const tab: BaseTabComponent = event.item.data
        this.app.hideTabReorderHint()
        // Sorting is disabled (see tabSortDisabled) — the real reorder is
        // committed by TabHeaderComponent, so this only ever reports no-op.
        if (event.previousIndex === event.currentIndex) {
            return
        }
        this.app.moveTabToIndex(tab, event.currentIndex)
    }

    /**
     * TabHeaderComponent drives the in-bar slide itself (placeholder clone
     * follows the pointer, siblings shift aside); CDK's discrete mid-drag
     * sorting would fight it, so it is switched off.
     */
    tabSortDisabled = (): boolean => false

    onTransfersChange () {
        if (this.activeTransfers.length === 0) {
            this.activeTransfersDropdown.close()
        }
    }

    private async getToolbarButtons (aboveZero: boolean): Promise<Command[]> {
        const surface = aboveZero ? ActionSurface.ToolbarRight : ActionSurface.ToolbarLeft
        const actions = this.actions.get(surface, { tab: this.app.activeTab })
        const actionCommands = actions.map(action => ({
            label: action.label,
            icon: action.icon,
            weight: action.weight,
            run: () => this.actions.run(action, { tab: this.app.activeTab }),
        }) as Command)

        // Keep the legacy command-location entries as well: registry actions and
        // those commands can both derive from the same ToolbarButtonProvider
        // set (duplicates are dropped), and future ActionProvider contributions
        // must not silently hide CommandLocation-based buttons.
        const legacyCommands = (await this.commands.getCommands({ tab: this.app.activeTab ?? undefined }))
            .filter(x => x.locations?.includes(aboveZero ? CommandLocation.RightToolbar : CommandLocation.LeftToolbar))
            .filter(x => !actionCommands.some(c => c.label === x.label && c.icon === x.icon && c.weight === x.weight))

        return [...actionCommands, ...legacyCommands]
            .sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0))
    }

    toggleMaximize (): void {
        // Swallow the second click of a double-click that lands on the tab
        // bar right after a tab was closed (which would otherwise toggle
        // maximize unintentionally).
        if (Date.now() - this.lastTabRemovedAt < 500) {
            this.lastTabRemovedAt = 0
            return
        }
        this.hostWindow.toggleMaximize()
    }

    isDocked (): boolean {
        return !!this.docking?.isDocked
    }

    protected isTitleBarNeeded (): boolean {
        return this.hostApp.platform !== Platform.macOS
            && this.config.store.appearance.tabsLocation !== 'top'
            && this.config.store.appearance.tabsLocation !== 'bottom'
    }
}
