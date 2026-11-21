import type { TerminalColorScheme } from 'tabby-core'
import type { ITheme } from '@xterm/xterm'

const COLOR_NAMES = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
]

/**
 * Parse a #rgb / #rrggbb / #rrggbbaa color string into r,g,b(,a) components.
 * Returns null if the string cannot be parsed.
 */
export function parseColor (color: string): { r: number, g: number, b: number, a: number } | null {
    const m = /^#([0-9a-f]{3,8})$/i.exec(color)
    if (!m) {
        return null
    }
    let hex = m[1]
    if (hex.length === 3) {
        hex = hex.split('').map(c => c + c).join('')
    }
    if (hex.length === 4) {
        hex = hex.split('').map(c => c + c).join('')
    }
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return { r, g, b, a }
}

/**
 * Blend a semi-transparent foreground color over an opaque background and
 * return the resulting opaque color as #rrggbb. If the foreground has no
 * alpha channel or is already opaque it is returned unchanged.
 */
export function blendOverBackground (foreground: string, background: string): string {
    const fg = parseColor(foreground)
    const bg = parseColor(background)
    if (!fg || !bg || fg.a >= 1) {
        return foreground
    }
    const a = fg.a
    const r = Math.round(fg.r * a + bg.r * (1 - a))
    const g = Math.round(fg.g * a + bg.g * (1 - a))
    const b = Math.round(fg.b * a + bg.b * (1 - a))
    return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Build the xterm ITheme for a color scheme. The selection background is
 * pre-blended and tagged with alpha=254: xterm's ThemeService forces *opaque*
 * selection backgrounds to 30% opacity (issue #2737), which only affects the
 * canvas renderer and leaves WebGL fully opaque. 254/255 is visually
 * indistinguishable from opaque, so both renderers agree.
 */
export function buildXtermTheme (options: {
    scheme: TerminalColorScheme
    background: string
}): ITheme {
    const { scheme, background } = options
    // Pre-blend the selection background with the terminal background so the
    // canvas renderer (which uses the transparent variant directly) and the
    // WebGL renderer (which uses the opaque, pre-blended variant) produce the
    // same selection color.
    const blendedSelection = scheme.selection ? blendOverBackground(scheme.selection, background) : undefined
    const selectionBackground = blendedSelection ? `${blendedSelection}FE` : undefined

    const theme: ITheme = {
        foreground: scheme.foreground,
        selectionBackground,
        selectionForeground: scheme.selectionForeground,
        background,
        cursor: scheme.cursor,
        cursorAccent: scheme.cursorAccent,
        // xterm 6 draws a 1px bright border on the overview ruler's right
        // edge; make it transparent so the terminal edge stays clean.
        overviewRulerBorder: '#00000000',
    }

    for (let i = 0; i < COLOR_NAMES.length; i++) {
        theme[COLOR_NAMES[i]] = scheme.colors[i]
    }

    return theme
}
