#!/usr/bin/env node
/**
 * Stage node-pty's bundled ConPTY binaries where its native module loads them from.
 *
 * `conpty.node` resolves `conpty.dll` at `conpty/conpty.dll` relative to its own
 * directory, i.e. `build/Release/conpty/`. That directory is a build artifact:
 * node-gyp wipes `build/Release` on every rebuild and does not put the DLLs back.
 * Staging them from node-pty's own `third_party` copy therefore belongs to both
 * the native build (dev runs load from the same path) and packaging itself —
 * electron-builder unpacks exactly `build/Release/conpty/*` into the app.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as url from 'url'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const NODE_PTY_DIR = path.resolve(__dirname, '../app/node_modules/node-pty')
const ARCH_DIRS = {
    x64: 'win10-x64',
    arm64: 'win10-arm64',
}

export function stageBundledConpty () {
    if (process.platform !== 'win32') {
        return
    }
    const arch = process.env.ARCH ?? process.arch
    const archDir = ARCH_DIRS[arch]
    if (!archDir) {
        throw new Error(`node-pty does not bundle ConPTY binaries for win32/${arch}`)
    }
    const versionDir = fs.readdirSync(path.join(NODE_PTY_DIR, 'third_party/conpty'))[0]
    const sourceDir = path.join(NODE_PTY_DIR, 'third_party/conpty', versionDir, archDir)
    const targetDir = path.join(NODE_PTY_DIR, 'build/Release/conpty')
    fs.mkdirSync(targetDir, { recursive: true })
    for (const file of ['conpty.dll', 'OpenConsole.exe']) {
        fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file))
    }
    console.info(`Staged bundled ConPTY (${versionDir}/${archDir}) -> build/Release/conpty`)
}
