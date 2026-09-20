#!/usr/bin/env node
import sh from 'shelljs'
import fs from 'node:fs'
import path from 'node:path'
import * as url from 'node:url'
import * as vars from './vars.mjs'
import log from 'npmlog'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

// `tabby-*` resolves to the sibling package root, whose `typings` the previous
// iteration of this loop just produced, so dependencies are emitted as `.d.ts`
// and never drag sources into the program. A couple of packages also import
// source files living outside them (`app/lib/config` from tabby-electron,
// `app/src/pluginBlacklist` from tabby-plugin-manager); those leak into the
// program, push the inferred `rootDir` up to the repository root and make tsc
// emit a nested `typings/<plugin>/src/...` tree that `package.json` cannot
// resolve. Lift the plugin's own declarations back to the root when that
// happens.
function normalizeTypings (plugin) {
    const dir = path.resolve(__dirname, '..', plugin, 'typings')
    if (!fs.existsSync(dir) || fs.existsSync(path.join(dir, 'index.d.ts'))) {
        return
    }
    const nested = path.join(dir, plugin, 'src')
    if (!fs.existsSync(nested)) {
        return
    }
    const own = new Set(fs.readdirSync(nested))
    for (const entry of fs.readdirSync(nested)) {
        fs.renameSync(path.join(nested, entry), path.join(dir, entry))
    }
    for (const entry of fs.readdirSync(dir)) {
        if (!own.has(entry)) {
            fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
        }
    }
}

for (const plugin of vars.builtinPlugins) {
    log.info('typings', plugin)
    sh.rm('-rf', `${plugin}/typings`)
    const result = sh.exec(`yarn tsc --project ${plugin}/tsconfig.typings.json`)
    if (result.code !== 0) {
        process.exit(result.code)
    }
    normalizeTypings(plugin)
}
