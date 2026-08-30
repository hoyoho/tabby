#!/usr/bin/env node
import sh from 'shelljs'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import * as vars from './vars.mjs'
import log from 'npmlog'
import { GettextExtractor, JsExtractors, HtmlExtractors } from 'gettext-extractor'

let extractor = new GettextExtractor()

const tempOutput = 'locale/app.new.pot'
const pot = 'locale/app.pot'
const tempHtml = 'locale/tmp-html'
const isWindows = platform() === 'win32'

;(async () => {
    sh.mkdir('-p', tempHtml)
    const { spawnSync } = await import('node:child_process')

    // pug binary path differs by platform
    const pugBin = isWindows
        ? resolve('node_modules/.bin/pug.cmd')
        : resolve('node_modules/.bin/pug')

    for (const plugin of vars.builtinPlugins) {
        log.info('compile-pug', plugin)
        const r = spawnSync(pugBin, ['--doctype', 'html', '-s', '--pretty', '-O', 'scripts/pug-options.js', '-o', `${tempHtml}/${plugin}`, plugin], {
            shell: isWindows,  // .cmd requires shell on Windows
            timeout: 30000,
        })
        if (r.status !== 0) {
            log.warn('compile-pug', `failed for ${plugin}, skipping`)
        }
    }

    log.info('extract-ts')
    extractor.createJsParser([
        JsExtractors.callExpression('this.translate.instant', {
            arguments: { text: 0 },
        }),
        JsExtractors.callExpression('translate.instant', {
            arguments: { text: 0 },
        }),
        JsExtractors.callExpression('_', {
            arguments: { text: 0 },
        }),
    ]).parseFilesGlob('./tabby-*/src/**/*.ts')

    log.info('extract-pug')
    const options = {
        attributes: {
            context: 'translatecontext',
        },
    }
    extractor.createHtmlParser([
        HtmlExtractors.elementContent('translate, [translate=""]', options),
        HtmlExtractors.elementAttribute('[translate*=" "]', 'translate', options),
    ]).parseFilesGlob(`${tempHtml}/**/*.html`)

    // Scan pug source files for `... | translate` pipes — both single- and
    // double-quoted strings, anywhere in the template (not just right after
    // `{{`), which gettext-extractor's HtmlExtractors doesn't handle.
    log.info('extract-pipes')
    const pipePattern = /(?:'([^']+)'|"([^"]+)")\s*\|\s*translate/g
    const pugFiles = sh.find('.').filter(f => f.endsWith('.pug') && f.includes('/src/'))
    const pipeMessages = new Set()
    for (const file of pugFiles) {
        const content = await fs.readFile(file, 'utf-8')
        let match
        while ((match = pipePattern.exec(content)) !== null) {
            pipeMessages.add(match[1] ?? match[2])
        }
    }
    log.info('extract-pipes', `found ${pipeMessages.size} unique messages from translate pipes`)

    extractor.savePotFile(tempOutput)
    extractor.printStats()

    // Append missing pipe messages after savePotFile creates the file
    const existingPot = await fs.readFile(tempOutput, 'utf-8')
    const newEntries = []
    for (const msgid of pipeMessages) {
        const escaped = msgid.replace(/"/g, '\\"').replace(/\n/g, '\\n')
        if (!existingPot.includes(`msgid "${escaped}"`)) {
            newEntries.push(`\nmsgid "${escaped}"\nmsgstr ""\n`)
        }
    }
    if (newEntries.length) {
        await fs.appendFile(tempOutput, newEntries.join(''))
        log.info('extract-pipes', `added ${newEntries.length} messages from translate pipes`)
    }

    sh.rm('-r', tempHtml)

    // Normalize pot file with msgcat if available (Linux/macOS),
    // otherwise just rename directly (Windows doesn't have msgcat by default)
    if (!isWindows) {
        const msgcatResult = spawnSync('msgcat', ['-s', tempOutput], { encoding: 'utf-8' })
        if (msgcatResult.status === 0) {
            await fs.writeFile(pot, msgcatResult.stdout, 'utf-8')
            await fs.unlink(tempOutput)
        } else {
            log.warn('msgcat not available, skipping normalization')
            await fs.rename(tempOutput, pot)
        }
    } else {
        await fs.rename(tempOutput, pot)
    }
})()
