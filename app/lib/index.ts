// Registers main-process error logging - must be first so it catches import-time errors
import { logMainError } from './errors'

import { app, ipcMain, Menu, dialog, crashReporter, screen } from 'electron'

// set userData Path on portable version
import './portable'

// set defaults of environment variables
import 'dotenv/config'
process.env.TABBY_PLUGINS ??= ''
process.env.TABBY_CONFIG_DIRECTORY ??= app.getPath('userData')

process.setSourceMapsEnabled(true)
import './sentry'
import './lru'
import { parseArgs } from './cli'
import { Application } from './app'
import { setupNativeDrag } from './nativeDrag'
import electronDebug from 'electron-debug'
import { loadConfig } from './config'

const argv = parseArgs(process.argv, process.cwd())

// eslint-disable-next-line @typescript-eslint/init-declarations
let configStore: any

try {
    configStore = loadConfig()
} catch (err) {
    dialog.showErrorBox('Could not read config', err.message)
    app.exit(1)
}

process.mainModule = module

const application = new Application(configStore)

// Register tabby:// URL scheme
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('tabby', process.execPath, [process.argv[1]])
    }
} else {
    app.setAsDefaultProtocolClient('tabby')
}

ipcMain.on('app:new-window', async (_event, payload) => {
    // The window is ALWAYS new: drops into an existing window travel through
    // the native drop handlers instead, and a release point that merely sits
    // within the bounds of a COVERED window must never silently re-home the
    // workspace into it (the detach would look like nothing happened).
    const options = payload?.x != null && payload?.y != null
        // Detach placement: open the workspace's window at the release point,
        // with its top-left clamped into the display that point sits on (vscode
        // maybeCreateAuxiliaryEditorPartAt parity) — the explicit placement
        // skips the persisted-bounds off-screen recalculation, so an edge
        // release would otherwise half-leave the screen.
        ? (() => {
            const point = { x: payload.x, y: payload.y }
            const workArea = screen.getDisplayNearestPoint(point).workArea
            return {
                x: Math.max(point.x, workArea.x),
                y: Math.max(point.y, workArea.y),
            }
        })()
        : undefined
    const window = await application.newWindow(options)
    if (payload?.recoveryToken) {
        // Deliver a workspace recovery token so the fresh window can rebuild
        // the dragged-out workspace (drag-out detach / move-to-window).
        window.send('window:open-recovery-token', payload.recoveryToken)
    }
})

// Cross-window drag & drop coordination (Chrome-style tab moving).
setupNativeDrag(application)

process.on('uncaughtException', err => {
    application.broadcast('uncaughtException', err)
})

if (argv.d) {
    electronDebug({
        isEnabled: true,
        showDevTools: true,
        devToolsMode: 'undocked',
    })
}

app.on('activate', async () => {
    if (!application.hasWindows()) {
        application.newWindow()
    } else {
        application.focus()
    }
})

// Handle URL scheme on macOS
app.on('open-url', async (event, url) => {
    event.preventDefault()
    console.log('Received open-url event:', url)
    if (!application.hasWindows()) {
        process.argv.push(url)
    } else {
        await app.whenReady()
        application.handleSecondInstance([url], process.cwd())
    }
})

app.on('second-instance', async (_event, newArgv, cwd) => {
    application.handleSecondInstance(newArgv, cwd)
})

if (!app.requestSingleInstanceLock()) {
    app.quit()
    app.exit(0)
}

app.on('ready', async () => {
    // Dev-only native crash capture (set TABBY_CRASH_DUMPS=1): writes crashpad
    // minidumps under the user-data dir when the renderer/main natively crashes,
    // so a "whole window vanished" crash can be rooted to its module. Never
    // enabled in normal runs.
    if (process.env.TABBY_CRASH_DUMPS) {
        crashReporter.start({ uploadToServer: false, compress: false })
    }

    if (process.platform === 'darwin') {
        app.dock.setMenu(Menu.buildFromTemplate([
            {
                label: 'New window',
                click () {
                    this.app.newWindow()
                },
            },
        ]))
    }

    try {
        application.init()

        const window = await application.newWindow({ hidden: argv.hidden })
        await window.ready
        window.passCliArguments(process.argv, process.cwd(), false)
        window.focus()
    } catch (err) {
        logMainError('Failed to open window', err)
        dialog.showErrorBox('Tabby failed to start', String(err?.stack ?? err))
        app.exit(1)
    }
})
