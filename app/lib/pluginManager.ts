import * as fs from 'fs'
import * as path from 'path'
import Arborist from '@npmcli/arborist'

import { loadConfig } from './config'
import { getArboristNetworkOptions } from './proxy'

// Arborist is npm's own install engine, used in-process so we don't have to bundle the 18 MB npm CLI
// and run it via ELECTRON_RUN_AS_NODE. reify() resolves and installs the full dependency tree.
export class PluginManager {
    async install (targetPath: string, name: string, version: string): Promise<void> {
        await new Arborist({
            path: targetPath,
            save: false,
            audit: false,
            fund: false,
            ...await getArboristNetworkOptions(loadConfig()),
        })
            .reify({ add: [`${name}@${version}`] })
    }

    async uninstall (targetPath: string, name: string): Promise<void> {
        // Remove the plugin directory directly instead of going through Arborist.
        // Installs run with save:false, so the user-plugins tree has no
        // package.json — Arborist therefore treats every locally-copied plugin
        // as "extraneous" and prunes them all whenever reify() runs. Uninstalling
        // one local plugin via Arborist wiped every other local plugin too.
        // A plain directory remove only touches the target, leaving siblings
        // (and their dependencies) untouched.
        const pluginPath = path.join(targetPath, 'node_modules', name)
        if (fs.existsSync(pluginPath)) {
            fs.rmSync(pluginPath, { recursive: true, force: true })
        }
    }
}

export const pluginManager = new PluginManager()
