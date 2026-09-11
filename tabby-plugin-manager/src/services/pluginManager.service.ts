import { compare as semverCompare } from 'semver'
import { Observable, from, forkJoin, map, of } from 'rxjs'
import { Injectable, Inject } from '@angular/core'
import { Logger, LogService, PlatformService, BOOTSTRAP_DATA, BootstrapData, PluginInfo } from 'tabby-core'
import { PLUGIN_BLACKLIST } from '../../../app/src/pluginBlacklist'
import * as fs from 'fs'
import * as path from 'path'

const OFFICIAL_NPM_ACCOUNT = 'eugenepankov'


@Injectable({ providedIn: 'root' })
export class PluginManagerService {
    logger: Logger
    userPluginsPath: string
    installedPlugins: PluginInfo[]

    private constructor (
        log: LogService,
        private platform: PlatformService,
        @Inject(BOOTSTRAP_DATA) bootstrapData: BootstrapData,
    ) {
        this.logger = log.create('pluginManager')
        this.installedPlugins = [...bootstrapData.installedPlugins]
        this.installedPlugins.sort((a, b) => a.name.localeCompare(b.name))
        this.userPluginsPath = bootstrapData.userPluginsPath
    }

    listAvailable (query?: string): Observable<PluginInfo[]> {
        return forkJoin(
            this._listAvailableInternal('tabby-', 'tabby-plugin', query),
            this._listAvailableInternal('terminus-', 'terminus-plugin', query),
        ).pipe(
            map(x => x.reduce((a, b) => a.concat(b), [])),
            map(x => {
                const names = new Set<string>()
                return x.filter(item => {
                    if (names.has(item.name)) {
                        return false
                    }
                    names.add(item.name)
                    return true
                })
            }),
            map(x => x.sort((a, b) => b.searchScore! - a.searchScore!)),
        )
    }

    listInstalled (query: string): Observable<PluginInfo[]> {
        return of(this.installedPlugins.filter(x=>x.name.includes(query)))
    }

    _listAvailableInternal (namePrefix: string, keyword: string, query?: string): Observable<PluginInfo[]> {
        return from(
            fetch(`https://registry.npmjs.com/-/v1/search?text=keywords%3A${keyword}%20${query}&size=250`).then(r => r.json()),
        ).pipe(
            map(response => response.objects
                .filter(item => !item.keywords?.includes('tabby-dummy-transition-plugin'))
                .map(item => ({
                    name: item.package.name.substring(namePrefix.length),
                    packageName: item.package.name,
                    description: item.package.description,
                    version: item.package.version,
                    homepage: item.package.links.homepage,
                    author: item.package.maintainers?.[0]?.username,
                    isOfficial: item.package.publisher.username === OFFICIAL_NPM_ACCOUNT,
                    searchScore: item.searchScore,
                })),
            ),
            map(plugins => plugins.filter(x => x.packageName.startsWith(namePrefix))),
            map(plugins => plugins.filter(x => !PLUGIN_BLACKLIST.includes(x.packageName))),
            map(plugins => {
                const mapping: Record<string, PluginInfo[]> = {}
                for (const p of plugins) {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                    mapping[p.name] ??= []
                    mapping[p.name].push(p)
                }
                return Object.values(mapping).map(list => {
                    list.sort((a, b) => -semverCompare(a.version, b.version))
                    return list[0]
                })
            }),
            map(plugins => plugins.sort((a, b) => a.name.localeCompare(b.name))),
        )
    }

    async installPlugin (plugin: PluginInfo): Promise<void> {
        try {
            await this.platform.installPlugin(plugin.packageName, plugin.version)
            this.installedPlugins = this.installedPlugins.filter(x => x.packageName !== plugin.packageName)
            this.installedPlugins.push(plugin)
        } catch (err) {
            this.logger.error(err)
            throw err
        }
    }

    async uninstallPlugin (plugin: PluginInfo): Promise<void> {
        try {
            await this.platform.uninstallPlugin(plugin.packageName)
            this.installedPlugins = this.installedPlugins.filter(x => x.packageName !== plugin.packageName)
        } catch (err) {
            this.logger.error(err)
            throw err
        }
    }

    /**
     * Copies a local plugin folder into the user plugins directory, so Tabby's
     * plugin discovery picks it up on the next boot. The install is a
     * standalone copy: the source folder can be moved or deleted afterwards
     * without affecting the installed plugin.
     *
     * @throws when the folder is not a valid Tabby plugin
     */
    addLocalPlugin (pluginDir: string): PluginInfo {
        const pkgPath = path.join(pluginDir, 'package.json')
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))

        const keywords: string[] = pkg.keywords ?? []
        if (!keywords.some(k => k === 'tabby-plugin' || k === 'tabby-builtin-plugin' || k === 'terminus-plugin' || k === 'terminus-builtin-plugin')) {
            throw new Error(`"${pkg.name ?? pluginDir}" is not a Tabby plugin: missing the "tabby-plugin" keyword in package.json`)
        }

        const prefix = (pkg.name as string).startsWith('tabby-') ? 'tabby-' : (pkg.name as string).startsWith('terminus-') ? 'terminus-' : null
        if (!prefix) {
            throw new Error(`Plugin package name must start with "tabby-" (got "${pkg.name}")`)
        }

        const targetPath = path.join(this.userPluginsPath, 'node_modules', pkg.name)
        if (fs.existsSync(targetPath)) {
            throw new Error(`Plugin "${pkg.name}" is already installed at ${targetPath}`)
        }

        fs.mkdirSync(path.dirname(targetPath), { recursive: true })
        fs.cpSync(pluginDir, targetPath, {
            recursive: true,
            filter: (src) => {
                const segments = src.split(path.sep)
                return !segments.some(s => s === 'node_modules' || s === '.git')
            },
        })

        const plugin: PluginInfo = {
            name: pkg.name.substring(prefix.length),
            packageName: pkg.name,
            isBuiltin: false,
            isLegacy: prefix === 'terminus-',
            version: pkg.version,
            description: pkg.description,
            author: (typeof pkg.author === 'string' ? pkg.author : pkg.author?.name) ?? '',
            path: targetPath,
            info: pkg,
        }
        this.installedPlugins.push(plugin)
        this.installedPlugins.sort((a, b) => a.name.localeCompare(b.name))
        return plugin
    }
}
