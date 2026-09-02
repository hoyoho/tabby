/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { debounce } from 'utils-decorators/dist/esm/debounce/debounce'
import { Component, HostBinding, Inject, Optional } from '@angular/core'
import {
    DockingService,
    ConfigService,
    Theme,
    HostAppService,
    Platform,
    isWindowsBuild,
    WIN_BUILD_FLUENT_BG_SUPPORTED,
    BaseComponent,
    PlatformService,
} from 'tabby-core'


/** @hidden */
@Component({
    selector: 'window-settings-tab',
    templateUrl: './windowSettingsTab.component.pug',
})
export class WindowSettingsTabComponent extends BaseComponent {
    Platform = Platform
    isFluentVibrancySupported = false

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
        public platform: PlatformService,
        @Inject(Theme) public themes: Theme[],
        @Optional() public docking?: DockingService,
    ) {
        super()

        this.themes = config.enabledServices(this.themes)

        this.isFluentVibrancySupported = isWindowsBuild(WIN_BUILD_FLUENT_BG_SUPPORTED)
    }

    @debounce(500)
    saveConfiguration (requireRestart?: boolean) {
        this.config.save()
        if (requireRestart) {
            this.config.requestRestart()
        }
    }

    get backgroundImageName (): string|null {
        const path = this.config.store.appearance.backgroundImage
        if (!path) {
            return null
        }
        return path.split(/[\\/]/).pop()
    }

    async selectBackgroundImage (): Promise<void> {
        const path = await this.platform.pickImage()
        if (path) {
            this.config.store.appearance.backgroundImage = path
            this.config.save()
        }
    }

    clearBackgroundImage (): void {
        this.config.store.appearance.backgroundImage = null
        this.config.save()
    }
}
