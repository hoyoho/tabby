import { NgZone, Injectable } from '@angular/core'
import { ConfigService, HostAppService, Platform, ProfilesService, TranslateService } from 'tabby-core'
import { ElectronService } from './electron.service'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class DockMenuService {
    appVersion: string
    // Serialized profile/recents identity of the last Windows Jump List build:
    // config changes fire often and a redundant setJumpList re-logs the native
    // "Failed to append custom category" ERROR per category on systems whose
    // privacy settings block custom categories.
    private lastJumpListKey: string|null = null

    private constructor (
        private configService: ConfigService,
        private electron: ElectronService,
        private hostApp: HostAppService,
        private zone: NgZone,
        private profilesService: ProfilesService,
        private translate: TranslateService,
    ) {
        this.configService.changed$.subscribe(() => this.update())
    }

    async update (): Promise<void> {
        let profiles = await this.profilesService.getProfiles()
        profiles = profiles.filter(x => x.id && !this.configService.store.profileBlacklist.includes(x.id))
        const recentProfiles = this.profilesService.getRecentProfiles().filter(x => x.id && !this.configService.store.profileBlacklist.includes(x.id))

        if (this.hostApp.platform === Platform.Windows) {
            // Skip rebuilds when the profile/recents set did not change.
            const key = JSON.stringify([profiles.map(p => p.id), recentProfiles.map(p => p.id)])
            if (key === this.lastJumpListKey) {
                return
            }
            this.lastJumpListKey = key
            try {
                this.electron.app.setJumpList([
                    {
                        type: 'custom',
                        name: this.translate.instant('Recent'),
                        items: recentProfiles.map((profile, index) => ({
                            type: 'task',
                            program: process.execPath,
                            args: `recent ${index}`,
                            title: profile.name,
                            iconPath: process.execPath,
                            iconIndex: 0,
                        })),
                    },
                    {
                        type: 'custom',
                        name: this.translate.instant('Profiles'),
                        items: profiles.map(profile => ({
                            type: 'task', program: process.execPath,
                            args: `profile "${profile.name}"`,
                            title: profile.name,
                            iconPath: process.execPath,
                            iconIndex: 0,
                        })),
                    },
                ])
            } catch {
                // System privacy settings can block custom Jump List
                // categories entirely (Electron logs the native ERROR itself);
                // the taskbar shortcuts are simply skipped.
            }
        }
        if (this.hostApp.platform === Platform.macOS) {
            this.electron.app.dock?.setMenu(this.electron.Menu.buildFromTemplate(
                [
                    ...[...recentProfiles, ...profiles].map(profile => ({
                        label: profile.name,
                        click: () => this.zone.run(async () => {
                            this.profilesService.openNewTabForProfile(profile)
                        }),
                    })),
                    {
                        label: this.translate.instant('New Window'),
                        click: () => this.zone.run(() => this.hostApp.newWindow()),
                    },
                ],
            ))
        }
    }
}
