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

    get cssVariables (): { name: string; value: string; source: string }[] {
        // A variable is attributed to the most specific source that declares
        // it: user custom CSS first, then plugin modules, then the theme.
        const sources: [source: string, cssText: string][] = []
        if (this.config.store.appearance.css) {
            sources.push(['custom', this.config.store.appearance.css])
        }
        for (const chunk of this.themes.getGlobalStyleChunks()) {
            if (chunk.css) {
                sources.push([chunk.module, chunk.css])
            }
        }
        const themeStyle = document.querySelector<HTMLStyleElement>('style#theme')
        if (themeStyle?.textContent) {
            sources.push(['theme', themeStyle.textContent])
        }
        sources.push(['theme', document.documentElement.style.cssText])
        const regexp = /(--[a-zA-Z0-9-]+)\s*:\s*([^;}]+);/g
        const result: { name: string; value: string; source: string }[] = []
        const seen = new Set<string>()
        const computed = getComputedStyle(document.documentElement)
        for (const [source, cssText] of sources) {
            regexp.lastIndex = 0
            let match: RegExpExecArray|null
            while ((match = regexp.exec(cssText))) {
                if (match[1].startsWith('--bs-') || match[1].startsWith('--icon-')) {
                    continue
                }
                const name = match[1]
                if (seen.has(name)) {
                    continue
                }
                seen.add(name)
                result.push({ name, value: computed.getPropertyValue(name).trim() || match[2].trim(), source })
            }
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