import { Inject, Injectable, Optional } from '@angular/core'
import { BaseTabComponent, WorkspaceComponent, TabContextMenuItemProvider, MenuItemOptions, ProfilesService, TranslateService } from 'tabby-core'
import { TerminalTabComponent } from './components/terminalTab.component'
import { LocalProfile, UACService } from './api'

/** @hidden */
@Injectable()
export class NewTabContextMenu extends TabContextMenuItemProvider {
    weight = 10

    constructor (
        private profilesService: ProfilesService,
        @Optional() @Inject(UACService) private uac: UACService|undefined,
        private translate: TranslateService,
    ) {
        super()
    }

    async getItems (tab: BaseTabComponent, _tabHeader?: boolean): Promise<MenuItemOptions[]> {
        if (tab.parent instanceof WorkspaceComponent) {
            // Session (pane-tab) menus only carry an UAC elevation entry.
            return this.sessionItems(tab)
        }
        // The workspace header no longer creates new sessions from its context
        // menu 鈥?use the 锛?toolbar button / profile panel instead.
        return []
    }

    private sessionItems (tab: BaseTabComponent): MenuItemOptions[] {
        if (tab instanceof TerminalTabComponent && this.uac?.isAvailable) {
            return [{
                label: this.translate.instant('Run as administrator'),
                click: () => {
                    this.profilesService.openNewTabForProfile(
                        this.withAdmin(tab.profile, true),
                    )
                },
            }]
        }
        return []
    }

    private withAdmin <T extends LocalProfile> (profile: T, admin: boolean): T {
        return {
            ...profile,
            options: {
                ...profile.options,
                runAsAdministrator: admin,
            },
        } as T
    }
}
