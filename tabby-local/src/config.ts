import { ConfigProvider, Platform } from 'tabby-core'

/** @hidden */
export class TerminalConfigProvider extends ConfigProvider {
    defaults = {
        terminal: {
            autoOpen: true,
            useConPTY: true,
            environment: {},
            setComSpec: false,
            windowsRefreshEnvironment: true,
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                'new-tab': [
                    '⌘-T',
                ],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                'new-tab': [
                    'Ctrl-Shift-T',
                ],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                'new-tab': [
                    'Ctrl-Shift-T',
                ],
            },
        },
    }
}
