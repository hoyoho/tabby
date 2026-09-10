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
        await new Arborist({ path: targetPath, save: false })
            .reify({ rm: [name] })
    }
}

export const pluginManager = new PluginManager()
