import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveX11DisplaySpec } from '../tabby-core/src/x11.ts'

test('resolveX11DisplaySpec parses host:display without a screen suffix', () => {
    assert.deepEqual(resolveX11DisplaySpec('example:10'), { host: 'example', port: 6010 })
})

test('resolveX11DisplaySpec ignores the screen suffix', () => {
    assert.deepEqual(resolveX11DisplaySpec('example:12.1'), { host: 'example', port: 6012 })
})

test('resolveX11DisplaySpec accepts an explicit socket path', () => {
    assert.deepEqual(resolveX11DisplaySpec('/tmp/x11-test'), { path: '/tmp/x11-test' })
})

test('resolveX11DisplaySpec falls back to display 0 for an empty host', () => {
    const spec = resolveX11DisplaySpec(':0')
    if (process.platform === 'win32') {
        assert.deepEqual(spec, { host: 'localhost', port: 6000 })
    } else {
        assert.deepEqual(spec, { path: '/tmp/.X11-unix/X0' })
    }
})
