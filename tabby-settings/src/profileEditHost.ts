/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    AppService,
    ProfileEditHost,
    EditProfileOptions,
    EditProfileGroupResult,
    PartialProfile,
    Profile,
    ProfileProvider,
    PartialProfileGroup,
    ProfileGroup,
} from 'tabby-core'

import { EditProfileModalComponent } from './components/editProfileModal.component'
import { EditProfileGroupModalComponent } from './components/editProfileGroupModal.component'
import { SettingsTabComponent } from './components/settingsTab.component'

/**
 * Implements the core-defined ProfileEditHost using the settings plugin's
 * modals. Core calls this contract and never hardcodes the plugin package name.
 */
/** @hidden */
@Injectable()
export class SettingsProfileEditHost extends ProfileEditHost {
    constructor (
        private ngbModal: NgbModal,
        private app: AppService,
    ) {
        super()
    }

    async editProfile (options: EditProfileOptions): Promise<PartialProfile<Profile>|null> {
        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )
        modal.componentInstance.partialProfile = options.partialProfile
        modal.componentInstance.profileProvider = options.provider
        if (options.defaultsMode) {
            modal.componentInstance.defaultsMode = options.defaultsMode
        }
        return (await modal.result.catch(() => null)) ?? null
    }

    async editProfileGroup (
        group: PartialProfileGroup<ProfileGroup>,
        providers: ProfileProvider<Profile>[],
    ): Promise<EditProfileGroupResult|null> {
        const modal = this.ngbModal.open(
            EditProfileGroupModalComponent,
            { size: 'lg' },
        )
        modal.componentInstance.group = group as any
        modal.componentInstance.providers = providers
        return (await modal.result.catch(() => null)) ?? null
    }

    openSettings (activeTab?: string): void {
        SettingsTabComponent.openSettingsTab(this.app, activeTab)
    }
}