import { test } from 'node:test'
import assert from 'node:assert/strict'

import { paneHitAt } from '../tabby-core/src/components/workspace.hitTest.ts'

const cell = { pane: { id: 'pane-1' }, x: 0, y: 0, w: 100, h: 100 }
const base = { origin: { left: 10, top: 20 }, cells: [cell], headerHeight: 30 }

test('paneHitAt resolves the merge band above the body split', () => {
    const hit = paneHitAt({ ...base, x: 60, y: 60 })
    assert.equal(hit?.side, 'all')
    assert.deepEqual(hit?.rect, { left: 10, top: 50, width: 100, height: 70 })
})

test('paneHitAt resolves left, right, top and bottom zones', () => {
    assert.equal(paneHitAt({ ...base, x: 20, y: 90 })?.side, 'l')
    assert.equal(paneHitAt({ ...base, x: 100, y: 90 })?.side, 'r')
    assert.equal(paneHitAt({ ...base, x: 60, y: 82 })?.side, 't')
    assert.equal(paneHitAt({ ...base, x: 60, y: 100 })?.side, 'b')
})

test('paneHitAt ignores the header strip and points outside the cells', () => {
    assert.equal(paneHitAt({ ...base, x: 60, y: 30 }), null)
    assert.equal(paneHitAt({ ...base, x: 5, y: 60 }), null)
    assert.equal(paneHitAt({ ...base, x: 60, y: 60, cells: [] }), null)
})
