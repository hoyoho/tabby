/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable } from '@angular/core'
import { ConfigService } from './services/config.service'
import { ProfilesService } from './services/profiles.service'
import { SessionService } from './services/session.service'
import { CommandService } from './services/commands.service'
import { HomeBaseService } from './services/homeBase.service'
import { PlatformService } from './api/platform'
import { HostWindowService } from './api/hostWindow'
import { MenuProvider, AppMenu, AppMenuItem } from './api/menuProvider'

/** @hidden */
@Injectable()
export class AppMenuProvider extends MenuProvider {
    constructor (
        private config: ConfigService,
        private profiles: ProfilesService,
        private session: SessionService,
        private commands: CommandService,
        private hostWindow: HostWindowService,
        private platform: PlatformService,
        private homeBase: HomeBaseService,
    ) {
        super()
    }

    getMenus (): AppMenu[] {
        const recents = this.recentSessions()
        const clearRecents = recents.length
            ? [{
                label: 'Clear recent sessions',
                separatorBefore: true,
                click: () => {
                    window.localStorage.removeItem('recentProfiles')
                    this.config.save()
                },
            }]
            : []
        return [
            {
                label: 'Session',
                items: [
                    {
                        label: 'Select profile',
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
                        label: 'Select layout',
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
                label: 'View',
                weight: 40,
                items: [
                    {
                        label: 'Toggle fullscreen',
                        weight: 0,
                        click: () => this.hostWindow.toggleFullscreen(),
                    },
                    {
                        label: 'Command palette',
                        weight: 10,
                        click: () => this.commands.showSelector(),
                    },
                    {
                        separatorBefore: true,
                        weight: 30,
                        label: 'Profile sidebar',
                        checked: this.config.store.showProfileTree,
                        click: () => this.toggleProfileTree(),
                    },
                ],
            },
            {
                label: 'Help',
                weight: 1000,
                items: [
                    {
                        label: 'Report a problem',
                        click: () => this.homeBase.reportBug(),
                    },
                    {
                        label: 'Community',
                        click: () => this.homeBase.openDiscord(),
                    },
                    {
                        label: 'GitHub',
                        click: () => this.homeBase.openGitHub(),
                    },
                    {
                        separatorBefore: true,
                        label: 'About',
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
