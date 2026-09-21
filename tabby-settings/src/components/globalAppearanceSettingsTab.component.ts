/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { debounce } from 'utils-decorators/dist/esm/debounce/debounce'
import { Component, HostBinding, Inject } from '@angular/core'
import {
    BaseComponent,
    ConfigService,
    HostAppService,
    Platform,
    Theme,
    ThemesService,
    isWindowsBuild,
    WIN_BUILD_FLUENT_BG_SUPPORTED,
} from 'tabby-core'


/** @hidden */
@Component({
    selector: 'global-appearance-settings-tab',
    templateUrl: './globalAppearanceSettingsTab.component.pug',
    styleUrls: ['./globalAppearanceSettingsTab.component.scss'],
})
export class GlobalAppearanceSettingsTabComponent extends BaseComponent {
    Platform = Platform
    showCssVariableReference = false

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public themes: ThemesService,
        public hostApp: HostAppService,
        @Inject(Theme) public themeList: Theme[],
    ) {
        super()

        this.themeList = config.enabledServices(this.themeList)
    }

    /**
     * Acrylic (the Fluent DWM material) is Windows-only, and from Windows 10
     * 1803 onwards it is the only usable style — see `resolveVibrancyStyle`.
     */
    get supportsAcrylicVibrancy (): boolean {
        return this.hostApp.platform === Platform.Windows && isWindowsBuild(WIN_BUILD_FLUENT_BG_SUPPORTED)
    }

    get supportsBlurVibrancy (): boolean {
        return !this.supportsAcrylicVibrancy
    }

    /**
     * The value shown in the dropdown. A stored style this machine cannot
     * render (e.g. `blur` carried over from Windows 10 1803+, or `acrylic`
     * copied from Windows onto macOS) has no matching `<option>` and would
     * leave the select blank; map it onto a supported one for display only,
     * without rewriting the config.
     */
    get vibrancyStyle (): string {
        const value = this.config.store.appearance.vibrancy ?? 'off'
        if (value === 'blur' && !this.supportsBlurVibrancy) { return 'acrylic' }
        if (value === 'acrylic' && !this.supportsAcrylicVibrancy) { return 'blur' }
        return value
    }

    onVibrancyStyleChange (value: string): void {
        this.config.store.appearance.vibrancy = value
        // Linux needs the window re-created to pick up the transparent visuals
        // and disabled GPU that vibrancy requires, so ask for a restart there.
        this.saveConfiguration(this.hostApp.platform === Platform.Linux)
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