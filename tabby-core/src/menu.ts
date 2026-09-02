/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable, Injector, Optional } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import { ConfigService } from './services/config.service'
import { ProfilesService } from './services/profiles.service'
import { SessionService } from './services/session.service'
import { CommandService } from './services/commands.service'
import { HomeBaseService } from './services/homeBase.service'
import { PlatformService } from './api/platform'
import { HostWindowService } from './api/hostWindow'
import { MenuProvider, AppMenu, AppMenuItem } from './api/menuProvider'
import { DockSide, DockingService } from './services/docking.service'

/** @hidden */
@Injectable()
export class AppMenuProvider extends MenuProvider {
    private translate: TranslateService|undefined

    constructor (
        private injector: Injector,
        private config: ConfigService,
        private profiles: ProfilesService,
        private session: SessionService,
        private commands: CommandService,
        private hostWindow: HostWindowService,
        private platform: PlatformService,
        private homeBase: HomeBaseService,
        @Optional() private docking?: DockingService,
    ) {
        super()
    }

    private t (str: string): string {
        try {
            this.translate ??= this.injector.get(TranslateService)
            return this.translate.instant(str)
        } catch {
            return str
        }
    }

    getMenus (): AppMenu[] {
        const recents = this.recentSessions()
        const clearRecents = recents.length
            ? [{
                label: this.t('Clear recent sessions'),
                separatorBefore: true,
                click: () => {
                    window.localStorage.removeItem('recentProfiles')
                    this.config.save()
                },
            }]
            : []
        return [
            {
                name: 'Session',
                label: this.t('Session'),
                items: [
                    {
                        label: this.t('Select profile'),
                        click: async () => {
                            const profile = await this.profiles
                                .showProfileSelector(p => p.type !== 'split-layout')
                                .catch(() => null)
                            if (profile) {
                                this.session.launch(profile)
                            }
                        },
                    },
                    {
                        label: this.t('Select layout'),
                        click: async () => {
                            const profile = await this.profiles
                                .showProfileSelector(p => p.type === 'split-layout')
                                .catch(() => null)
                            if (profile) {
                                this.session.launch(profile)
                            }
                        },
                    },
                    ...recents.map((item, index) => ({
                        ...item,
                        separatorBefore: index === 0,
                    })),
                    ...clearRecents,
                ],
            },
            {
                name: 'View',
                label: this.t('View'),
                weight: 40,
                items: [
                    {
                        label: this.t('Toggle fullscreen'),
                        weight: 0,
                        click: () => this.hostWindow.toggleFullscreen(),
                    },
                    {
                        label: this.t('Command palette'),
                        weight: 10,
                        click: () => this.commands.showSelector(),
                    },
                    {
                        separatorBefore: true,
                        weight: 30,
                        label: this.t('Profile sidebar'),
                        checked: this.config.store.showProfileTree,
                        click: () => this.toggleProfileTree(),
                    },
                    ...this.dockPositionMenu(),
                ],
            },
            {
                name: 'Help',
                label: this.t('Help'),
                weight: 1000,
                items: [
                    {
                        label: this.t('Report a problem'),
                        click: () => this.homeBase.reportBug(),
                    },
                    {
                        label: this.t('Community'),
                        click: () => this.homeBase.openDiscord(),
                    },
                    {
                        label: this.t('GitHub'),
                        click: () => this.homeBase.openGitHub(),
                    },
                    {
                        separatorBefore: true,
                        label: this.t('About'),
                        click: () => this.about(),
                    },
                ],
            },
        ]
    }

    private recentSessions (): AppMenuItem[] {
        return this.profiles.getRecentProfiles().map(p => ({
            label: p.name,
            click: () => {
                this.profiles.launchProfile(p as any)
            },
        }))
    }

    /**
     * Dock position is session-scoped and applies only to the window this menu
     * is opened in — it is never persisted and never affects other windows.
     */
    private dockPositionMenu (): AppMenuItem[] {
        const docking = this.docking
        if (!docking) {
            return []
        }
        const labels: Record<DockSide, string> = {
            off: 'Off',
            left: 'Left',
            right: 'Right',
            top: 'Top',
            bottom: 'Bottom',
        }
        const sides: DockSide[] = ['off', 'left', 'right', 'top', 'bottom']
        return [{
            separatorBefore: true,
            weight: 35,
            label: this.t('Dock position'),
            click: () => undefined,
            children: sides.map(side => ({
                label: this.t(labels[side]),
                checked: docking.dockSide === side,
                click: () => docking.setDockSide(side),
            })),
        }]
    }

    private toggleProfileTree (): void {
        this.config.store.showProfileTree = !this.config.store.showProfileTree
        this.config.save()
    }

    private about (): void {
        this.platform.showMessageBox({
            type: 'warning',
            message: `Tabby ${this.platform.getAppVersion()}`,
            buttons: ['OK'],
        })
    }
}
