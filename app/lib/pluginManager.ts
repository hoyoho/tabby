import * as fs from 'fs'
import * as path from 'path'
import Arborist from '@npmcli/arborist'

import { loadConfig } from './config'
import { getArboristNetworkOptions } from './proxy'

/** Plugins installed from npm. npm owns this directory: it prunes anything not declared in `package.json`. */
const NPM_PLUGINS_DIR = 'node_modules'
/** User-supplied plugins. Kept outside npm's directory so installs can never prune them. */
const LOCAL_PLUGINS_DIR = 'local'

const PLUGIN_PACKAGE_PREFIXES = ['tabby-', 'terminus-']

// Arborist is npm's own install engine, used in-process so we don't have to bundle the 18 MB npm CLI
// and run it via ELECTRON_RUN_AS_NODE. reify() resolves and installs the full dependency tree.
export class PluginManager {
    async install (targetPath: string, name: string, version: string): Promise<void> {
        this.adoptLocalPlugins(targetPath)
        const arborist = await this.arborist(targetPath)
        await arborist.reify({ add: [`${name}@${version}`] })
    }

    async uninstall (targetPath: string, name: string): Promise<void> {
        // A local plugin is a copy of ours, not an npm package: the directory is
        // the whole install, so removing it is the entire job.
        const localPath = path.join(targetPath, LOCAL_PLUGINS_DIR, name)
        if (fs.existsSync(localPath)) {
            fs.rmSync(localPath, { recursive: true, force: true })
        }

        if (!this.declaredDependencies(targetPath).has(name)) {
            return
        }

        this.adoptLocalPlugins(targetPath)

        // npm-managed plugins are uninstalled through npm, so that the entry in
        // package.json and package-lock.json goes away along with the files.
        // Deleting just the directory would leave the plugin declared, and the
        // next install would see a missing dependency and install it right back.
        const arborist = await this.arborist(targetPath)
        await arborist.reify({ rm: [name] })
    }

    /** npm, set up for the plugin tree — used for every operation that has to stay in sync with package.json. */
    private async arborist (targetPath: string): Promise<Arborist> {
        return new Arborist({
            path: targetPath,
            save: false,
            audit: false,
            fund: false,
            ...await getArboristNetworkOptions(loadConfig()),
        })
    }

    /**
     * Moves plugins that npm does not know about out of its directory, into `local`.
     *
     * npm treats every package missing from `plugins/package.json` as extraneous
     * and deletes it on the next reify(), which would silently take local plugins
     * down with any install or upgrade. Adoption keeps the two plugin sources in
     * their own directories: npm manages `node_modules`, we manage `local`.
     *
     * Throws when a plugin cannot be moved, rather than letting the install delete it.
     */
    private adoptLocalPlugins (targetPath: string): void {
        const nodeModules = path.join(targetPath, NPM_PLUGINS_DIR)
        if (!fs.existsSync(nodeModules)) {
            return
        }

        const declared = this.declaredDependencies(targetPath)

        for (const name of fs.readdirSync(nodeModules)) {
            if (declared.has(name) || !PLUGIN_PACKAGE_PREFIXES.some(p => name.startsWith(p))) {
                continue
            }

            const source = path.join(nodeModules, name)
            if (!fs.existsSync(path.join(source, 'package.json'))) {
                continue
            }

            const destination = path.join(targetPath, LOCAL_PLUGINS_DIR, name)
            if (fs.existsSync(destination)) {
                console.warn(`Plugin ${name} is present in both ${NPM_PLUGINS_DIR} and ${LOCAL_PLUGINS_DIR}; keeping the ${LOCAL_PLUGINS_DIR} copy`)
                continue
            }

            fs.mkdirSync(path.dirname(destination), { recursive: true })
            try {
                fs.renameSync(source, destination)
                console.info(`Moved local plugin ${name} to ${LOCAL_PLUGINS_DIR}`)
            } catch (error) {
                throw new Error(`Cannot move local plugin "${name}" to ${destination}: ${error.message}. Move it there manually and retry.`)
            }
        }
    }

    /** Names npm is told to install, i.e. everything it is allowed to prune. */
    private declaredDependencies (targetPath: string): Set<string> {
        const packageJsonPath = path.join(targetPath, 'package.json')
        if (!fs.existsSync(packageJsonPath)) {
            return new Set()
        }
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
        return new Set(Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }))
    }
}

export const pluginManager = new PluginManager()
