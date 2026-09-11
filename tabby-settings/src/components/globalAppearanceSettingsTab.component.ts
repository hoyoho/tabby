/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { debounce } from 'utils-decorators/dist/esm/debounce/debounce'
import { Component, HostBinding, Inject } from '@angular/core'
import {
    BaseComponent,
    ConfigService,
    Theme,
    ThemesService,
} from 'tabby-core'


/** @hidden */
@Component({
    selector: 'global-appearance-settings-tab',
    templateUrl: './globalAppearanceSettingsTab.component.pug',
    styleUrls: ['./globalAppearanceSettingsTab.component.scss'],
})
export class GlobalAppearanceSettingsTabComponent extends BaseComponent {
    showCssVariableReference = false

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public themes: ThemesService,
        @Inject(Theme) public themeList: Theme[],
    ) {
        super()

        this.themeList = config.enabledServices(this.themeList)
    }

    get pluginGlobalStyles (): string {
        return this.themes.getGlobalStyles()
    }

    get cssVariables (): { name: string; value: string }[] {
        const cssText = document.documentElement.style.cssText
        const regexp = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g
        const result: { name: string; value: string }[] = []
        let match: RegExpExecArray|null
        while ((match = regexp.exec(cssText))) {
            if (match[1].startsWith('--bs-') || match[1].startsWith('--icon-')) {
                continue
            }
            result.push({ name: match[1], value: match[2].trim() })
        }
        return result.sort((a, b) => a.name.localeCompare(b.name))
    }

    @debounce(500)
    saveConfiguration (requireRestart?: boolean) {
        this.config.save()
        if (requireRestart) {
            this.config.requestRestart()
        }
    }
}