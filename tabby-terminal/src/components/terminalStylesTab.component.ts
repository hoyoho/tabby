/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Observable, debounceTime, distinctUntilChanged, map } from 'rxjs'
import { debounce } from 'utils-decorators/dist/esm/debounce/debounce'

import { Component } from '@angular/core'
import { ConfigService, getCSSFontFamily, PlatformService, ThemesService } from 'tabby-core'

/** @hidden */
@Component({
    selector: 'terminal-styles-tab',
    templateUrl: './terminalStylesTab.component.pug',
    styleUrls: ['./terminalStylesTab.component.scss'],
})
export class TerminalStylesTabComponent {
    fonts: string[] = []
    defaultTab = 'dark'

    constructor (
        public config: ConfigService,
        public themes: ThemesService,
        private platform: PlatformService,
    ) {
        const mode = this.config.store.appearance.colorSchemeMode
        if (mode === 'dark' || mode === 'light') {
            this.defaultTab = mode
        } else {
            this.defaultTab = platform.getTheme()
        }
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