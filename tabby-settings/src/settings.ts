import { Injectable } from '@angular/core'
import { SettingsTabProvider } from './api'
import { GlobalAppearanceSettingsTabComponent } from './components/globalAppearanceSettingsTab.component'
import { HotkeySettingsTabComponent } from './components/hotkeySettingsTab.component'
import { WindowSettingsTabComponent } from './components/windowSettingsTab.component'
import { VaultSettingsTabComponent } from './components/vaultSettingsTab.component'
import { ProfilesSettingsTabComponent } from './components/profilesSettingsTab.component'
import { TranslateService } from 'tabby-core'

/** @hidden */
@Injectable()
export class AppearanceSettingsTabProvider extends SettingsTabProvider {
    id = 'appearance'
    icon = 'swatchbook'
    title = this.translate.instant('Appearance')
    prioritized = true

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return GlobalAppearanceSettingsTabComponent
    }
}

/** @hidden */
@Injectable()
export class HotkeySettingsTabProvider extends SettingsTabProvider {
    id = 'hotkeys'
    icon = 'keyboard'
    title = this.translate.instant('Hotkeys')

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return HotkeySettingsTabComponent
    }
}


/** @hidden */
@Injectable()
export class WindowSettingsTabProvider extends SettingsTabProvider {
    id = 'window'
    icon = 'window-maximize'
    title = this.translate.instant('Window')

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return WindowSettingsTabComponent
    }
}


/** @hidden */
@Injectable()
export class VaultSettingsTabProvider extends SettingsTabProvider {
    id = 'vault'
    icon = 'key'
    title: string

    constructor (translate: TranslateService) {
        super()
        this.title = translate.instant('Vault')
    }

    getComponentType (): any {
        return VaultSettingsTabComponent
    }
}


/** @hidden */
@Injectable()
export class ProfilesSettingsTabProvider extends SettingsTabProvider {
    id = 'profiles'
    icon = 'window-restore'
    title = this.translate.instant('Sessions')
    prioritized = true

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return ProfilesSettingsTabComponent
    }
}
