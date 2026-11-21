#!/usr/bin/env node
/**
 * Builds the Windows UAC helper (`extras/UAC.exe`) from `tabby-uac/`.
 *
 * The packaged app ships the prebuilt binary; this script keeps the checked-in
 * source reproducible. It is Windows-only and intentionally not part of the
 * normal cross-platform build.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as url from 'node:url'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const root = path.resolve(__dirname, '..')
const solution = path.join(root, 'tabby-uac', 'UAC.sln')
const output = path.join(root, 'extras', 'UAC.exe')

function findMsbuild () {
    const where = spawnSync('where', ['msbuild'], { encoding: 'utf8' })
    if (where.status === 0) {
        return where.stdout.split(/\r?\n/).find(Boolean) ?? null
    }
    const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    if (!fs.existsSync(vswhere)) {
        return null
    }
    const result = spawnSync(vswhere, [
        '-latest',
        '-requires', 'Microsoft.Component.MSBuild',
        '-find', 'MSBuild\\**\\Bin\\MSBuild.exe',
    ], { encoding: 'utf8' })
    return result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean) ?? null : null
}

function findBuiltExe (dir) {
    const found = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            found.push(...findBuiltExe(full))
        } else if (entry.name.toLowerCase() === 'uac.exe') {
            found.push(full)
        }
    }
    return found
}

if (process.platform !== 'win32') {
    console.log('UAC helper is Windows-only; skipping. extras/UAC.exe is the prebuilt artifact.')
    process.exit(0)
}

const msbuild = findMsbuild()
if (!msbuild) {
    console.error('MSBuild was not found. Install Visual Studio Build Tools with the C++ workload.')
    process.exit(1)
}

console.log('Building', solution)
const build = spawnSync(msbuild, [
    solution,
    '/m',
    '/p:Configuration=Release',
    '/p:Platform=x64',
], { stdio: 'inherit' })
if (build.status !== 0) {
    process.exit(build.status ?? 1)
}

const candidates = findBuiltExe(path.join(root, 'tabby-uac'))
    .filter(file => file.includes('Release') && !file.includes('Debug'))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
if (!candidates.length) {
    console.error('Build succeeded but no Release/UAC.exe was produced under tabby-uac/.')
    process.exit(1)
}

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.copyFileSync(candidates[0], output)
console.log(`Updated ${path.relative(root, output)} from ${path.relative(root, candidates[0])}`)
