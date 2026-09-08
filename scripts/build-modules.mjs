#!/usr/bin/env node
import * as vars from './vars.mjs'
import log from 'npmlog'
import webpack from 'webpack'
import { promisify } from 'node:util'

// Build plugins first so that app bundles pick up fresh plugin output
const configs = [
    ...vars.allPackages.map(x => `../${x}/webpack.config.mjs`),
    '../app/webpack.config.main.mjs',
    '../app/webpack.config.mjs',
];

const watch = process.argv.includes('--watch')

const watching = []

function exit () {
    for (const w of watching) {
        if (w) {
            w.close(() => {})
        }
    }
    process.exit(0)
}

(async () => {
    try {
        for (const c of configs) {
            log.info('build', c)
            const cfg = (await import(c)).default()
            if (watch) {
                log.info('build', `watching ${c} (incremental; Ctrl+C to stop)`)
                watching.push(webpack({ ...cfg, watch: true }, (err, stats) => {
                    if (err) {
                        log.error('build', err)
                        return
                    }
                    console.log(stats.toString({ colors: true, preset: 'minimal' }))
                    if (stats.hasErrors()) {
                        log.error('build', `${c} has errors`)
                    } else if (stats.compilation && stats.compilation.modules) {
                        log.info('build', `${c} rebuilt ok`)
                    }
                }))
            } else {
                const stats = await promisify(webpack)(cfg)
                console.log(stats.toString({ colors: true }))
                if (stats.hasErrors()) {
                    process.exit(1)
                }
            }
        }
        if (watch) {
            process.on('SIGINT', exit)
            process.on('SIGTERM', exit)
        }
    } catch (error) {
        log.error('build', String(error))
        process.exit(1)
    }
})()
