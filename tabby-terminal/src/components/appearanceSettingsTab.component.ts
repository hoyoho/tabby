/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Observable, debounceTime, distinctUntilChanged, map } from 'rxjs'
import { debounce } from 'utils-decorators/dist/esm/debounce/debounce'

import { Component } from '@angular/core'
import { ConfigService, getCSSFontFamily, PlatformService, ThemesService } from 'tabby-core'

/** @hidden */
@Component({
    templateUrl: './appearanceSettingsTab.component.pug',
    styleUrls: ['./appearanceSettingsTab.component.scss'],
})
export class AppearanceSettingsTabComponent {
    fonts: string[] = []

    constructor (
        public config: ConfigService,
        public themes: ThemesService,
        private platform: PlatformService,
    ) { }

    get pluginGlobalStyles (): string {
        return this.themes.getGlobalStyles()
    }

    showCssVariableReference = false

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

    async ngOnInit () {
        this.fonts = await this.platform.listFonts()
    }

    fontAutocomplete = (text$: Observable<string>) => {
        return text$.pipe(
            debounceTime(200),
            distinctUntilChanged(),
            map(query => this.fonts.filter(v => new RegExp(query, 'gi').test(v))),
            map(list => Array.from(new Set(list))),
        )
    }

    getPreviewFontFamily () {
        return getCSSFontFamily(this.config.store)
    }

    @debounce(500)
    saveConfiguration (requireRestart?: boolean) {
        this.config.save()
        if (requireRestart) {
            this.config.requestRestart()
        }
    }

    fixFontSize () {
        this.config.store.terminal.fontSize = Math.min(
            50,
            Math.max(
                5,
                this.config.store.terminal.fontSize,
            ),
        )
    }
}
