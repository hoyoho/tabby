import { Inject, Injectable } from '@angular/core'
import { Subject, Observable } from 'rxjs'
import * as Color from 'color'
import { pathToFileURL } from 'url'
import { ConfigService } from '../services/config.service'
import { TerminalColorScheme, Theme } from '../api/theme'
import { PlatformService, PlatformTheme } from '../api/platform'
import { NewTheme } from '../theme'

@Injectable({ providedIn: 'root' })
export class ThemesService {
    get themeChanged$ (): Observable<Theme> { return this.themeChanged }
    private themeChanged = new Subject<Theme>()

    private styleElement: HTMLElement|null = null
    private rootElementStyleBackup = ''

    /** @hidden */
    private constructor (
        private config: ConfigService,
        private standardTheme: NewTheme,
        private platform: PlatformService,
        @Inject(Theme) private themes: Theme[],
    ) {
        this.rootElementStyleBackup = document.documentElement.style.cssText
        this.applyTheme(standardTheme)
        this.applyThemeVariables()
        config.ready$.toPromise().then(() => {
            this.applyCurrentTheme()
            this.applyThemeVariables()
            platform.themeChanged$.subscribe(() => {
                this.applyCurrentTheme()
                this.applyThemeVariables()
            })
            config.changed$.subscribe(() => {
                this.applyCurrentTheme()
                this.applyThemeVariables()
            })
        })
    }

    private getConfigStoreOrDefaults (): any {
        /// Theme service is active before the vault is unlocked and config is available
        return this.config.store ?? this.config.getDefaults()
    }

    private applyThemeVariables () {
        if (!this.findCurrentTheme().followsColorScheme) {
            document.documentElement.style.cssText = this.rootElementStyleBackup
        }

        const theme = this._getActiveColorScheme()
        const isDark = Color(theme.background).luminosity() < Color(theme.foreground).luminosity()

        function more (some, factor) {
            if (isDark) {
                return Color(some).darken(factor)
            }
            return Color(some).lighten(factor)
        }

        function less (some, factor) {
            if (!isDark) {
                return Color(some).darken(factor)
            }
            return Color(some).lighten(factor)
        }

        let background = Color(theme.background)
        if (this.getConfigStoreOrDefaults().appearance.vibrancy) {
            background = background.fade(0.6)
        }
        // const background = theme.background
        const backgroundMore = more(background.string(), 0.25).string()
        // const backgroundMore =more(theme.background, 0.25).string()
        const accentIndex = 4
        const vars: Record<string, string> = {}
        const contrastPairs: string[][] = []

        vars['--body-bg'] = background.string()
        if (this.findCurrentTheme().followsColorScheme) {
            vars['--bs-body-bg'] = theme.background
            vars['--bs-body-color'] = theme.foreground
            vars['--bs-black'] = theme.colors[0]
            vars['--bs-red'] = theme.colors[1]
            vars['--bs-green'] = theme.colors[2]
            vars['--bs-yellow'] = theme.colors[3]
            vars['--bs-blue'] = theme.colors[4]
            vars['--bs-purple'] = theme.colors[5]
            vars['--bs-cyan'] = theme.colors[6]
            vars['--bs-gray'] = theme.colors[7]
            vars['--bs-gray-dark'] = theme.colors[8]
            // vars['--bs-red'] = theme.colors[9]
            // vars['--bs-green'] = theme.colors[10]
            // vars['--bs-yellow'] = theme.colors[11]
            // vars['--bs-blue'] = theme.colors[12]
            // vars['--bs-purple'] = theme.colors[13]
            // vars['--bs-cyan'] = theme.colors[14]

            contrastPairs.push(['--bs-body-bg', '--bs-body-color'])

            vars['--theme-fg-more-2'] = more(theme.foreground, 0.5).string()
            vars['--theme-fg-more'] = more(theme.foreground, 0.25).string()
            vars['--theme-fg'] = theme.foreground
            vars['--theme-fg-less'] = less(theme.foreground, 0.25).string()
            vars['--theme-fg-less-2'] = less(theme.foreground, 0.5).string()

            vars['--theme-bg-less-2'] = less(theme.background, 0.5).string()
            vars['--theme-bg-less'] = less(theme.background, 0.25).string()
            vars['--theme-bg'] = theme.background
            vars['--theme-bg-more'] = backgroundMore
            vars['--theme-bg-more-2'] = more(backgroundMore, 0.25).string()

            contrastPairs.push(['--theme-bg', '--theme-fg'])
            contrastPairs.push(['--theme-bg-less', '--theme-fg-less'])
            contrastPairs.push(['--theme-bg-less-2', '--theme-fg-less-2'])
            contrastPairs.push(['--theme-bg-more', '--theme-fg-more'])
            contrastPairs.push(['--theme-bg-more-2', '--theme-fg-more-2'])

            const themeColors = {
                primary: theme.colors[accentIndex],
                secondary: isDark
                    ? less(theme.background, 0.5).string()
                    : less(theme.background, 0.125).string(),
                tertiary: more(theme.background, 0.75).string(),
                warning: theme.colors[3],
                danger: theme.colors[1],
                success: theme.colors[2],
                info: theme.colors[4],
                dark: more(theme.background, 0.75).string(),
                light: more(theme.foreground, 0.5).string(),
                link: theme.colors[8], // for .btn-link
            }

            for (const [key, color] of Object.entries(themeColors)) {
                vars[`--bs-${key}-bg`] = more(color, 0.5).string()
                vars[`--bs-${key}-color`] = less(color, 0.5).string()
                vars[`--bs-${key}`] = color
                vars[`--bs-${key}-rgb`] = Color(color).rgb().array().join(', ')
                vars[`--theme-${key}-more-2`] = more(color, 1).string()
                vars[`--theme-${key}-more`] = more(color, 0.5).string()
                vars[`--theme-${key}`] = color
                vars[`--theme-${key}-less`] = less(color, 0.25).string()
                vars[`--theme-${key}-less-2`] = less(color, 0.75).string()
                vars[`--theme-${key}-fg`] = more(color, 3).string()

                vars[`--theme-${key}-active-bg`] = less(color, 1).string()
                vars[`--theme-${key}-active-fg`] = more(color, 1).string()

                contrastPairs.push([`--theme-${key}`, `--theme-${key}-fg`])
                contrastPairs.push([`--theme-${key}-active-bg`, `--theme-${key}-active-fg`])
            }

            // Scheme slots surfaced for UI use (also edited in the scheme
            // editor's labeled cards): cursor / block-cursor accent / selection.
            if (theme.cursor) {
                vars['--theme-cursor'] = theme.cursor
            }
            if (theme.cursorAccent) {
                vars['--theme-cursor-accent'] = theme.cursorAccent
            }
            if (theme.selection) {
                vars['--theme-selection'] = theme.selection
            }
            if (theme.selectionForeground) {
                vars['--theme-selection-fg'] = theme.selectionForeground
            }

            const switchBackground = less(theme.colors[accentIndex], 0.25).string()
            vars['--bs-form-switch-bg'] = `url("data:image/svg+xml,%3csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%27-4 -4 8 8%27%3e%3ccircle r=%273%27 fill=%27${switchBackground}%27/%3e%3c/svg%3e")`
        }

        vars['--spaciness'] = this.getConfigStoreOrDefaults().appearance.spaciness
        const backgroundImage = this.getConfigStoreOrDefaults().appearance.backgroundImage
        if (backgroundImage) {
            // Convert a platform path into a CSS-loadable file URL. Direct
            // interpolation breaks on Windows (backslashes are escapes inside
            // url()) and is unportable across platforms, so normalize via
            // pathToFileURL when available and fall back to fixing separators.
            let imageUrl: string
            try {
                imageUrl = pathToFileURL(backgroundImage).toString()
            } catch {
                imageUrl = 'file:///' + backgroundImage.replace(/\\/g, '/').replace(/^\/?(?=[A-Za-z]:)/, '').replace(/'/g, '%27').replace(/"/g, '%22')
            }
            // The background image and its dark scrim are scoped to the
            // workspace/terminal area only. Settings, menus and other chrome
            // keep their regular opaque surfaces.
            vars['--app-workspace-image'] = `url("${imageUrl}")`
            const brightness = this.getConfigStoreOrDefaults().appearance.backgroundImageBrightness
            const scrimAlpha = Math.max(0, Math.min(1, 1 - brightness))
            vars['--app-workspace-scrim'] = `rgba(20, 22, 26, ${scrimAlpha})`
        } else {
            vars['--app-workspace-image'] = 'none'
            vars['--app-workspace-scrim'] = 'transparent'
        }

        for (const [bg, fg] of contrastPairs) {
            const colorBg = Color(vars[bg]).hsl()
            const colorFg = Color(vars[fg]).hsl()
            const bgContrast = colorBg.contrast(colorFg)
            if (bgContrast < this.getConfigStoreOrDefaults().terminal.minimumContrastRatio) {
                vars[fg] = this.ensureContrast(colorFg, colorBg).string()
            }
        }

        for (const [key, value] of Object.entries(vars)) {
            document.documentElement.style.setProperty(key, value)
        }

        document.body.classList.toggle('no-animations', !this.getConfigStoreOrDefaults().accessibility.animations)
    }

    private ensureContrast (color: Color, against: Color): Color {
        const a = this.increaseContrast(color, against, 1.1)
        const b = this.increaseContrast(color, against, 0.9)
        return a.contrast(against) > b.contrast(against) ? a : b
    }

    private increaseContrast (color: Color, against: Color, step=1.1): Color {
        color = color.hsl()
        color.color[2] = Math.max(color.color[2], 0.01)
        while (
            (step < 1 && color.color[2] > 1 ||
             step > 1 && color.color[2] < 99) &&
             color.contrast(against) < this.getConfigStoreOrDefaults().terminal.minimumContrastRatio) {
            color.color[2] *= step
        }
        return color
    }

    findTheme (name: string): Theme|null {
        return this.config.enabledServices(this.themes).find(x => x.name === name) ?? null
    }

    findCurrentTheme (): Theme {
        return this.findTheme(this.getConfigStoreOrDefaults().appearance.theme) ?? this.standardTheme
    }

    /// @hidden
    _getActiveColorScheme (): TerminalColorScheme {
        // Fallback: config may lack a color scheme when the plugin that
        // provides it (e.g. tabby-terminal) is disabled; core must still boot
        const fallbackScheme: TerminalColorScheme = {
            name: 'Fallback',
            foreground: '#cacaca',
            background: '#171717',
            cursor: '#bbbbbb',
            colors: [
                '#000000',
                '#ff615a',
                '#b1e969',
                '#ebd99c',
                '#5da9f6',
                '#e86aff',
                '#82fff7',
                '#dedacf',
                '#313131',
                '#f58c80',
                '#ddf88f',
                '#eee5b2',
                '#a5c7ff',
                '#ddaaff',
                '#b7fff9',
                '#ffffff',
            ],
        }

        const configStore = this.getConfigStoreOrDefaults()
        let theme: PlatformTheme = 'dark'
        if (configStore.appearance?.colorSchemeMode === 'light') {
            theme = 'light'
        } else if (configStore.appearance?.colorSchemeMode === 'auto') {
            theme = this.platform.getTheme()
        }

        const scheme = theme === 'light'
            ? configStore.terminal?.lightColorScheme
            : configStore.terminal?.colorScheme
        return scheme ?? fallbackScheme
    }

    applyTheme (theme: Theme): void {
        if (!this.styleElement) {
            this.styleElement = document.createElement('style')
            this.styleElement.setAttribute('id', 'theme')
            document.querySelector('head')!.appendChild(this.styleElement)
        }
        this.styleElement.textContent = theme.css
        document.querySelector('style#custom-css')!.innerHTML = this.getConfigStoreOrDefaults().appearance.css
        this.themeChanged.next(theme)
    }

    private applyCurrentTheme (): void {
        this.applyTheme(this.findCurrentTheme())
    }
}
