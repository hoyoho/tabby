import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizePastedText, trimPastedText } from '../tabby-terminal/src/api/paste.ts'

const plain = { windows: false, replaceNewlinesWithSpaces: false, trimWhitespaceOnPaste: false }

test('normalizePastedText converts clipboard line endings to CR', () => {
    assert.equal(normalizePastedText('a\nb\n', plain), 'a\rb\r')
    assert.equal(normalizePastedText('a\r\nb\r\n', { ...plain, windows: true }), 'a\rb\r')
})

test('normalizePastedText can replace newlines with spaces', () => {
    assert.equal(normalizePastedText('a\n\nb', { ...plain, replaceNewlinesWithSpaces: true }), 'a b')
})

test('normalizePastedText drops a single trailing newline when trimming', () => {
    const options = { ...plain, windows: true, trimWhitespaceOnPaste: true }
    assert.equal(normalizePastedText('hello\n', options), 'hello')
    assert.equal(normalizePastedText('hello\nworld\n', options), 'hello\nworld\n')
})

test('trimPastedText preserves leading whitespace for multi-line input', () => {
    assert.equal(trimPastedText('  hello  '), 'hello')
    assert.equal(trimPastedText('  hello\rworld'), '  hello\rworld')
})
