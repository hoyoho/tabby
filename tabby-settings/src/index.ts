import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import { InfiniteScrollModule } from 'ngx-infinite-scroll'

import TabbyCorePlugin, { ToolbarButtonProvider, HotkeyProvider, ConfigProvider, MenuProvider, ProfileEditHost } from 'tabby-core'

import { EditProfileModalComponent } from './components/editProfileModal.component'
import { EditProfileGroupModalComponent } from './components/editProfileGroupModal.component'
import { HotkeyInputModalComponent } from './components/hotkeyInputModal.component'
import { HotkeySettingsTabComponent } from './components/hotkeySettingsTab.component'
import { MultiHotkeyInputComponent } from './components/multiHotkeyInput.component'
import { SettingsTabComponent } from './components/settingsTab.component'
import { SettingsTabBodyComponent } from './components/settingsTabBody.component'
import { WindowSettingsTabComponent } from './components/windowSettingsTab.component'
import { VaultSettingsTabComponent }  from './components/vaultSettingsTab.component'
import { SetVaultPassphraseModalComponent } from './components/setVaultPassphraseModal.component'
import { ProfilesSettingsTabComponent } from './components/profilesSettingsTab.component'
import { ReleaseNotesComponent } from './components/releaseNotesTab.component'
import { ShowSecretModalComponent } from './components/showSecretModal.component'


import { SettingsTabProvider } from './api'
import { HotkeySettingsTabProvider, WindowSettingsTabProvider, VaultSettingsTabProvider, ProfilesSettingsTabProvider } from './settings'
import { ButtonProvider } from './buttonProvider'
import { SettingsHotkeyProvider } from './hotkeys'
import { SettingsConfigProvider } from './config'
import { SettingsMenuProvider } from './menu'
import { SettingsProfileEditHost } from './profileEditHost'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        TabbyCorePlugin,
        InfiniteScrollModule,
    ],
    providers: [
        { provide: ToolbarButtonProvider, useClass: ButtonProvider, multi: true },
        { provide: MenuProvider, useClass: SettingsMenuProvider, multi: true },
        { provide: ProfileEditHost, useClass: SettingsProfileEditHost },
        { provide: ConfigProvider, useClass: SettingsConfigProvider, multi: true },
        { provide: HotkeyProvider, useClass: SettingsHotkeyProvider, multi: true },
        { provide: SettingsTabProvider, useClass: HotkeySettingsTabProvider, multi: true },
        { provide: SettingsTabProvider, useClass: WindowSettingsTabProvider, multi: true },
        { provide: SettingsTabProvider, useClass: VaultSettingsTabProvider, multi: true },
        { provide: SettingsTabProvider, useClass: ProfilesSettingsTabProvider, multi: true },
    ],
    declarations: [
        EditProfileModalComponent,
        EditProfileGroupModalComponent,
        HotkeyInputModalComponent,
        HotkeySettingsTabComponent,
        MultiHotkeyInputComponent,
        ProfilesSettingsTabComponent,
        SettingsTabComponent,
        SettingsTabBodyComponent,
        SetVaultPassphraseModalComponent,
        VaultSettingsTabComponent,
        WindowSettingsTabComponent,
        ReleaseNotesComponent,
        ShowSecretModalComponent,
    ],
})
export default class SettingsModule {} // eslint-disable-line @typescript-eslint/no-extraneous-class

export * from './api'
export {
    SettingsTabComponent,
    EditProfileModalComponent,
    EditProfileGroupModalComponent,
}
