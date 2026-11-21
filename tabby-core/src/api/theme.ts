/**
 * Extend to add a custom CSS theme
 */
export abstract class Theme {
    name: string

    /**
     * Complete CSS stylesheet
     */
    css: string

    terminalBackground: string

    macOSWindowButtonsInsetX?: number
    macOSWindowButtonsInsetY?: number
    followsColorScheme?: boolean
}

export interface TerminalColorScheme {
    name: string
    foreground: string
    background: string
    cursor: string
    colors: string[]
    selection?: string
    selectionForeground?: string
    cursorAccent?: string
}

/** Shared default palette (also used as the core fallback before plugins load). */
export const DefaultColorScheme: TerminalColorScheme = {
    name: 'Tabby Default',
    foreground: '#cacaca',
    background: '#171717',
    cursor: '#bbbbbb',
    selection: '#ffffff',
    selectionForeground: '#000000',
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

export const DefaultLightColorScheme: TerminalColorScheme = {
    name: 'Tabby Default Light',
    foreground: '#4d4d4c',
    background: '#ffffff',
    cursor: '#4d4d4c',
    selection: '#000000',
    selectionForeground: '#ffffff',
    colors: [
        '#000000',
        '#c82829',
        '#718c00',
        '#eab700',
        '#4271ae',
        '#8959a8',
        '#3e999f',
        '#ffffff',
        '#000000',
        '#c82829',
        '#718c00',
        '#eab700',
        '#4271ae',
        '#8959a8',
        '#3e999f',
        '#ffffff',
    ],
}
