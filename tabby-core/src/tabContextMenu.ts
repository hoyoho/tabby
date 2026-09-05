/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { TranslateService } from '@ngx-translate/core'
import { Subscription } from 'rxjs'
import { AppService } from './services/app.service'
import { ConfigService } from './services/config.service'
import { BaseTabComponent } from './components/baseTab.component'
import { SessionTab } from './api/session'
import { WorkspaceComponent, SplitDirection } from './components/workspace.component'
import { TabContextMenuItemProvider } from './api/tabContextMenuProvider'
import { MenuItemOptions } from './api/menu'
import { TopLevelTab } from './api/topLevelTab'
import { SessionService } from './services/session.service'
import { HotkeysService } from './services/hotkeys.service'
import { PromptModalComponent } from './components/promptModal.component'
import { SplitLayoutProfilesService } from './profiles'
import { TAB_COLORS } from './utils'

/** @hidden */
@Injectable()
export class TabManagementContextMenu extends TabContextMenuItemProvider {
    weight = 99

    constructor (
        private app: AppService,
        private config: ConfigService,
        private translate: TranslateService,
    ) {
        super()
    }

    async getItems (tab: BaseTabComponent): Promise<MenuItemOptions[]> {
        const isPage = !tab.parent && !(tab instanceof WorkspaceComponent)
        let items: MenuItemOptions[] = [
            {
                label: this.translate.instant('Close'),
                commandLabel: tab.parent instanceof WorkspaceComponent
                    ? this.translate.instant('Close session')
                    : isPage
                        ? this.translate.instant('Close')
                        : this.translate.instant('Close workspace'),
                enabled: tab.parent instanceof WorkspaceComponent
                    ? true
                    : !tab.effectivelyPinned,
                click: () => {
                    if (this.app.tabs.includes(tab)) {
                        this.app.closeTab(tab, true)
                    } else {
                        this.closeSubTab(tab)
                    }
                },
            },
        ]
        if (!tab.parent) {
            const verticalBar = this.config.store.appearance.tabsLocation === 'left' || this.config.store.appearance.tabsLocation === 'right'
            items = [
                ...items,
                {
                    id: 'context:close-other-workspaces',
                    label: this.translate.instant('Close other workspaces'),
                    click: () => {
                        for (const t of this.app.tabs.filter(x => x !== tab)) {
                            this.app.closeTab(t, true)
                        }
                    },
                },
                {
                    id: 'context:close-workspaces-above',
                    label: verticalBar
                        ? this.translate.instant('Close workspaces above')
                        : this.translate.instant('Close workspaces to the left'),
                    click: () => {
                        for (const t of this.app.tabs.slice(0, this.app.tabs.indexOf(tab))) {
                            this.app.closeTab(t, true)
                        }
                    },
                },
                {
                    id: 'context:close-workspaces-below',
                    label: verticalBar
                        ? this.translate.instant('Close workspaces below')
                        : this.translate.instant('Close workspaces to the right'),
                    click: () => {
                        for (const t of this.app.tabs.slice(this.app.tabs.indexOf(tab) + 1)) {
                            this.app.closeTab(t, true)
                        }
                    },
                },
            ]
        } else if (tab.parent instanceof WorkspaceComponent) {
            // Pane-scoped bulk close: a pane may stack several sessions; offer
            // closing the neighbours of the right-clicked one (left/right keep
            // it, "all" also closes it). Only meaningful with 2+ sessions and
            // strictly limited to the hosting pane.
            const pane = tab.parent.getPaneOf(tab as SessionTab)
            const index = pane?.tabs.indexOf(tab as SessionTab) ?? -1
            if (pane && pane.tabs.length > 1) {
                const closeSessions = (sessions: SessionTab[]): void => {
                    for (const session of sessions) {
                        void this.closeSubTab(session)
                    }
                }
                items.push(
                    {
                        id: 'context:close-sessions-to-the-left',
                        label: this.translate.instant('Close sessions to the left'),
                        enabled: index > 0,
                        click: () => closeSessions(pane.tabs.slice(0, index)),
                    },
                    {
                        id: 'context:close-sessions-to-the-right',
                        label: this.translate.instant('Close sessions to the right'),
                        enabled: index < pane.tabs.length - 1,
                        click: () => closeSessions(pane.tabs.slice(index + 1)),
                    },
                    {
                        id: 'context:close-sessions-all-in-pane',
                        label: this.translate.instant('Close all sessions in pane'),
                        click: () => closeSessions([...pane.tabs]),
                    },
                )
            }
            const directions: SplitDirection[] = ['r', 'b', 'l', 't']
            items.push({
                label: this.translate.instant('Split'),
                submenu: directions.map(dir => ({
                    label: {
                        r: this.translate.instant('Right'),
                        b: this.translate.instant('Down'),
                        l: this.translate.instant('Left'),
                        t: this.translate.instant('Up'),
                    }[dir],
                    commandLabel: {
                        r: this.translate.instant('Split to the right'),
                        b: this.translate.instant('Split to the bottom'),
                        l: this.translate.instant('Split to the left'),
                        t: this.translate.instant('Split to the top'),
                    }[dir],
                    click: () => {
                        (tab.parent as WorkspaceComponent).splitTab(tab as SessionTab, dir)
                    },
                })) as MenuItemOptions[],
            })
        }
        return items
    }

    /**
     * Closes a session (sub-tab as part of a workspace) after asking it for permission.
     * Lives at the workspace-pane level, so the tab stays out of the top-level `closeTab`
     * flow which would try to treat it as a whole workspace.
     */
    private async closeSubTab (tab: BaseTabComponent): Promise<void> {
        if (await tab.canClose()) {
            tab.destroy()
        }
    }
}

/** @hidden */
@Injectable()
export class CommonOptionsContextMenu extends TabContextMenuItemProvider {
    weight = -1

    constructor (
        private app: AppService,
        private ngbModal: NgbModal,
        private splitLayoutProfilesService: SplitLayoutProfilesService,
        private translate: TranslateService,
    ) {
        super()
    }

    async getItems (tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]> {
        const isSession = tab.parent instanceof WorkspaceComponent
        const isWorkspace = !tab.parent && tab instanceof WorkspaceComponent
        // Whole-page hosts (settings / welcome / release notes) only get the
        // close family from TabManagementContextMenu — nothing from here.
        if (!tabHeader || !isSession && !isWorkspace) {
            return []
        }
        let items: MenuItemOptions[] = []
        // tabHeader is guaranteed truthy here (the guard above returned for the
        // header-less pass) — kept as a brace scope for clarity.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (tabHeader) {
            const currentColor = TAB_COLORS.find(x => x.value === tab.color)?.name
            const allowRenameDuplicate = isSession || isWorkspace
            items = [
                ...items,
                ...allowRenameDuplicate
                    ? [{
                        label: this.translate.instant('Rename'),
                        commandLabel: isSession
                            ? this.translate.instant('Rename session')
                            : this.translate.instant('Rename workspace'),
                        click: () => {
                            this.app.renameTab(tab)
                        },
                    },
                    {
                        id: 'context:duplicate',
                        label: this.translate.instant('Duplicate'),
                        commandLabel: isSession
                            ? this.translate.instant('Duplicate session')
                            : this.translate.instant('Duplicate workspace'),
                        click: () => {
                            if (isSession) {
                                (tab.parent as WorkspaceComponent).duplicateSession(tab as SessionTab)
                            } else {
                                this.app.duplicateTab(tab)
                            }
                        },
                    }] as MenuItemOptions[]
                    : [],
                ...isSession
                    ? []
                    : [{
                        id: 'context:focus-all-sessions',
                        label: this.translate.instant('Focus all sessions'),
                        type: 'checkbox',
                        checked: (tab as WorkspaceComponent).focusAllMode,
                        click: () => (tab as WorkspaceComponent).toggleFocusAll(),
                    },
                    {
                        label: this.translate.instant('Pin'),
                        commandLabel: this.translate.instant('Pin workspace'),
                        type: 'checkbox',
                        checked: tab.pinned,
                        click: () => this.app.toggleTabPinned(tab),
                    },
                    {
                        id: 'context:color',
                        label: this.translate.instant('Color'),
                        commandLabel: this.translate.instant('Change workspace color'),
                        sublabel: currentColor ? this.translate.instant(currentColor) : undefined,
                        submenu: TAB_COLORS.map(color => ({
                            label: this.translate.instant(color.name) ?? color.name,
                            type: 'radio',
                            checked: tab.color === color.value,
                            click: () => {
                                tab.color = color.value
                            },
                        })) as MenuItemOptions[],
                    }] as MenuItemOptions[],
            ]

            if (tab instanceof WorkspaceComponent && tab.getAllTabs().length > 1) {
                items.push({
                    id: 'context:save-layout-as-profile',
                    label: this.translate.instant('Save layout as profile'),
                    click: async () => {
                        const modal = this.ngbModal.open(PromptModalComponent)
                        modal.componentInstance.prompt = this.translate.instant('Profile name')
                        const name = (await modal.result.catch(() => null))?.value
                        if (!name) {
                            return
                        }
                        this.splitLayoutProfilesService.createProfile(tab, name)
                    },
                })
            }
        }
        return items
    }
}

/** @hidden */
@Injectable()
export class TaskCompletionContextMenu extends TabContextMenuItemProvider {
    constructor (
        private app: AppService,
        private translate: TranslateService,
    ) {
        super()
    }

    /**
     * Brings the top-level tab hosting `tab` to the front and re-activates the
     * session inside it. Sessions are never top-level (R0/R1), so they must not
     * be handed to AppService.selectTab directly — that would leave a phantom
     * `_activeTab` that is not part of `AppService.tabs`.
     */
    private focusTopLevelHost (tab: BaseTabComponent): void {
        const host = tab.topmostParent
        if (host) {
            this.app.selectTab(host as TopLevelTab)
        }
        if (tab.parent instanceof WorkspaceComponent) {
            const pane = tab.parent.getPaneOf(tab as SessionTab)
            if (pane) {
                tab.parent.activatePaneTab(pane, tab as SessionTab)
            }
        }
    }

    async getItems (tab: BaseTabComponent): Promise<MenuItemOptions[]> {
        // Current-process / completion / activity notifications are per-session
        // concepts; a workspace aggregates sessions and whole-page hosts
        // (settings / welcome) expose no process at all.
        if (tab instanceof WorkspaceComponent || !tab.parent) {
            return []
        }
        const process = await tab.getCurrentProcess()
        const items: MenuItemOptions[] = []

        const extTab: (BaseTabComponent & { __completionNotificationEnabled?: boolean, __outputNotificationSubscription?: Subscription|null }) = tab

        if (process) {
            items.push({
                enabled: false,
                label: this.translate.instant('Current process: {name}', process),
            })
            items.push({
                label: this.translate.instant('Notify when done'),
                type: 'checkbox',
                checked: extTab.__completionNotificationEnabled,
                click: () => {
                    extTab.__completionNotificationEnabled = !extTab.__completionNotificationEnabled

                    if (extTab.__completionNotificationEnabled) {
                        this.app.observeTabCompletion(tab).subscribe(() => {
                            new Notification(this.translate.instant('Process completed'), {
                                body: process.name,
                            }).addEventListener('click', () => {
                                this.focusTopLevelHost(tab)
                            })
                            extTab.__completionNotificationEnabled = false
                        })
                    } else {
                        this.app.stopObservingTabCompletion(tab)
                    }
                },
            })
        }
        items.push({
            label: this.translate.instant('Notify on activity'),
            type: 'checkbox',
            checked: !!extTab.__outputNotificationSubscription,
            click: () => {
                tab.clearActivity()

                if (extTab.__outputNotificationSubscription) {
                    extTab.__outputNotificationSubscription.unsubscribe()
                    extTab.__outputNotificationSubscription = null
                } else {
                    extTab.__outputNotificationSubscription = tab.activity$.subscribe(active => {
                        if (extTab.__outputNotificationSubscription && active) {
                            extTab.__outputNotificationSubscription.unsubscribe()
                            extTab.__outputNotificationSubscription = null
                            new Notification(this.translate.instant('Tab activity'), {
                                body: tab.title,
                            }).addEventListener('click', () => {
                                this.focusTopLevelHost(tab)
                            })
                        }
                    })
                }
            },
        })
        return items
    }
}


/** @hidden */
@Injectable()
export class ProfilesContextMenu extends TabContextMenuItemProvider {
    weight = 10

    constructor (
        private session: SessionService,
        private translate: TranslateService,
        hotkeys: HotkeysService,
    ) {
        super()
        hotkeys.hotkey$.subscribe(hotkey => {
            if (hotkey === 'switch-profile') {
                const focused = this.session.getFocused()
                if (focused) {
                    this.session.switchProfile(focused)
                }
            }
        })
    }

    async getItems (tab: BaseTabComponent): Promise<MenuItemOptions[]> {
        if (tab.parent instanceof WorkspaceComponent) {
            return [
                {
                    label: this.translate.instant('Switch profile'),
                    click: () => this.session.switchProfile(tab as any),
                },
            ]
        }

        return []
    }
}
