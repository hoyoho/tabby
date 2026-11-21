import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const manifest = JSON.parse(fs.readFileSync(new URL('../plugins.json', import.meta.url), 'utf8'))
const appPackage = JSON.parse(fs.readFileSync(new URL('../app/package.json', import.meta.url), 'utf8'))

test('plugin manifest has no duplicate package names', () => {
    assert.equal(new Set(manifest.builtin).size, manifest.builtin.length)
    assert.equal(new Set(manifest.extraPackages).size, manifest.extraPackages.length)
})

test('every builtin plugin directory exists', () => {
    for (const name of manifest.builtin) {
        assert.ok(fs.existsSync(new URL(`../${name}/package.json`, import.meta.url)), `${name} is missing`)
    }
})

test('app peerDependencies cover every desktop builtin plugin', () => {
    for (const name of manifest.builtin.filter(name => name !== 'tabby-web')) {
        assert.ok(appPackage.peerDependencies[name], `${name} is missing from app/package.json peerDependencies`)
    }
})

test('extra build packages exist', () => {
    for (const name of manifest.extraPackages) {
        assert.ok(fs.existsSync(new URL(`../${name}/webpack.config.mjs`, import.meta.url)), `${name} has no webpack config`)
    }
})
