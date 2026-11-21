import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseColor, blendOverBackground, buildXtermTheme } from '../tabby-terminal/src/frontends/xtermTheme.ts'

test('parseColor expands #rgb and reads alpha from #rrggbbaa', () => {
    assert.deepEqual(parseColor('#abc'), { r: 0xaa, g: 0xbb, b: 0xcc, a: 1 })
    assert.deepEqual(parseColor('#11223380'), { r: 0x11, g: 0x22, b: 0x33, a: 128 / 255 })
    assert.equal(parseColor('not-a-color'), null)
})

test('blendOverBackground leaves opaque colors untouched', () => {
    assert.equal(blendOverBackground('#ffffff', '#000000'), '#ffffff')
    assert.equal(blendOverBackground('#0000', '#ffffff'), '#ffffff')
})

test('blendOverBackground blends a translucent color over the background', () => {
    assert.equal(blendOverBackground('#ffffff80', '#000000'), '#808080')
})

test('buildXtermTheme maps the ANSI palette', () => {
    const colors = Array.from({ length: 16 }, (_, i) => `#00000${i.toString(16)}`)
    const scheme = {
        foreground: '#ffffff',
        background: '#000000',
        cursor: '#00ff00',
        cursorAccent: '#000000',
        selection: '#ffffff80',
        selectionForeground: '#000000',
        colors,
    }
    const theme = buildXtermTheme({ scheme, background: '#000000' })
    assert.equal(theme.foreground, '#ffffff')
    assert.equal(theme.background, '#000000')
    assert.equal(theme.black, colors[0])
    assert.equal(theme.brightWhite, colors[15])
    // Blended selection is tagged with alpha 254 so xterm does not force 30% opacity.
    assert.equal(theme.selectionBackground, '#808080FE')
})
