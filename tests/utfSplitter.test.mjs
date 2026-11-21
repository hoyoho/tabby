import { test } from 'node:test'
import assert from 'node:assert/strict'

import { UTF8Splitter } from '../tabby-core/src/utfSplitter.ts'

test('UTF8Splitter holds an incomplete multi-byte sequence', () => {
    const splitter = new UTF8Splitter()
    assert.equal(splitter.write(Buffer.from([0xe4, 0xb8])).length, 0)
    assert.equal(splitter.write(Buffer.from([0xad])).toString('utf8'), '中')
})

test('UTF8Splitter flushes a dangling partial sequence', () => {
    const splitter = new UTF8Splitter()
    splitter.write(Buffer.from([0xe4, 0xb8]))
    assert.deepEqual([...splitter.flush()], [0xe4, 0xb8])
    assert.equal(splitter.flush().length, 0)
})
