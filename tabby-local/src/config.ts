import { ConfigProvider, Platform } from 'tabby-core'

/** @hidden */
export class TerminalConfigProvider extends ConfigProvider {
    defaults = {
        terminal: {
            useConPTY: true,
            /**
             * Local PTY host process model:
             * - 'shared'      one helper process for all local sessions (lowest memory)
             * - 'per-session' one helper process per session (a native crash/hang
             *                 only takes down that session, at ~50 MB per session)
             */
            ptyHostMode: 'shared',
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
            // ConPTY teardown can natively crash the helper process; isolate each
            // session by default on Windows so one bad teardown can't close them all.
            terminal: {
                ptyHostMode: 'per-session',
            },
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
