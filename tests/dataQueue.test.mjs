import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DataQueue } from '../app/lib/dataQueue.ts'

function drain (rounds = 4) {
    let promise = Promise.resolve()
    for (let i = 0; i < rounds; i++) {
        promise = promise.then(() => new Promise(resolve => setImmediate(resolve)))
    }
    return promise
}

test('DataQueue emits bounded chunks and drains the backlog', async () => {
    const chunks = []
    const queue = new DataQueue(data => chunks.push(data.toString()), {
        maxChunk: 4,
        maxInFlight: 8,
    })

    queue.push(Buffer.from('abcdefghij'))
    await drain()

    assert.deepEqual(chunks, ['abcd', 'efgh', 'ij'])
})

test('DataQueue stops emitting after the in-flight window is exceeded', async () => {
    const chunks = []
    const queue = new DataQueue(data => chunks.push(data.toString()), {
        maxChunk: 4,
        maxInFlight: 4,
    })

    queue.push(Buffer.from('abcdefghijkl'))
    await drain()
    assert.deepEqual(chunks, ['abcd', 'efgh'])

    queue.ack(4)
    await drain()
    assert.deepEqual(chunks, ['abcd', 'efgh', 'ijkl'])
})

test('DataQueue pauses and resumes the producer around the window', async () => {
    let pauses = 0
    let resumes = 0
    const chunks = []
    const queue = new DataQueue(data => chunks.push(data.toString()), {
        maxChunk: 4,
        maxInFlight: 4,
        pause: () => { pauses++ },
        resume: () => { resumes++ },
    })

    queue.push(Buffer.from('abcdefghijkl'))
    await drain()
    assert.equal(pauses, 1)
    assert.equal(resumes, 0)

    queue.ack(8)
    await drain()
    assert.equal(resumes, 1)
    assert.deepEqual(chunks, ['abcd', 'efgh', 'ijkl'])
})

test('DataQueue stops emitting after stop()', async () => {
    const chunks = []
    const queue = new DataQueue(data => chunks.push(data.toString()), {
        maxChunk: 4,
        maxInFlight: 8,
    })

    queue.stop()
    queue.push(Buffer.from('abcdefgh'))
    await drain()
    assert.deepEqual(chunks, [])
})
