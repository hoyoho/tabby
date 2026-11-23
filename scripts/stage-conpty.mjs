#!/usr/bin/env node
/**
 * Stage node-pty's bundled ConPTY binaries next to the module that will load them.
 *
 * `conpty.node` resolves `conpty.dll` at `conpty/conpty.dll` relative to its own
 * directory, so the DLLs must sit beside whichever module the loader picks. There
 * are two possible layouts:
 *
 * - rebuilt (build-native / @electron/rebuild): `build/Release/conpty.node`, whose
 *   `build/Release/conpty/` directory node-gyp wipes on every rebuild — that is
 *   what this function restores.
 * - prebuilt (no native rebuild): `prebuilds/<platform>-<arch>/conpty.node`, which
 *   ships its own `conpty/` pair inside the node-pty package. Nothing to stage;
 *   packaging keeps that pair (see electron-builder.yml) so the pair stays complete.
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
    if (!fs.existsSync(path.join(NODE_PTY_DIR, 'build/Release/conpty.node'))) {
        // No rebuilt module: the loader uses the self-contained prebuilt pair,
        // and creating build/Release/conpty here would only ship a stray DLL.
        console.info('Bundled ConPTY: node-pty was not rebuilt, using its prebuilt pair')
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
