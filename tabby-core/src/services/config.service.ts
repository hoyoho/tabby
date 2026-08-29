import deepClone from 'clone-deep'
import deepEqual from 'deep-equal'
import { v4 as uuidv4 } from 'uuid'
import * as yaml from 'js-yaml'
import { Observable, Subject, AsyncSubject, lastValueFrom } from 'rxjs'
import { Injectable, Inject, Optional } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import { ConfigProvider } from '../api/configProvider'
import { PlatformService } from '../api/platform'
import { HostAppService } from '../api/hostApp'
import { PLUGIN_MODULES } from '../api/mainProcess'
import { Vault, VaultService } from './vault.service'
import { serializeFunction } from '../utils'
import { PartialProfileGroup, ProfileGroup } from '../api/profileProvider'
const deepmerge = require('deepmerge')

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const configMerge = (a, b) => deepmerge(a, b, { arrayMerge: (_d, s) => s }) // eslint-disable-line @typescript-eslint/no-var-requires

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const configMergeByDefault = (a, b) => deepmerge(a, b) // eslint-disable-line @typescript-eslint/no-var-requires

/**
 * Ordered config migrations. Each `run` mutates the store; the framework writes
 * `config.version` after a migration succeeds, so a throwing migration is
 * re-run on the next boot. The loop re-evaluates `config.version` top-down, so
 * only the steps above the stored version run, in order.
 */
interface AnyConfigMigration { version: number, run: (config: any) => void }

const CONFIG_MIGRATIONS: AnyConfigMigration[] = [
    {
        version: 1,
        run: config => {
            for (const connection of config.ssh?.connections ?? []) {
                if (connection.privateKey) {
                    connection.privateKeys = [connection.privateKey]
                    delete connection.privateKey
                }
            }
        },
    },
    {
        version: 2,
        run: config => {
            config.profiles ??= []
            if (config.terminal?.recoverTabs !== undefined) {
                config.recoverTabs = config.terminal.recoverTabs
                delete config.terminal.recoverTabs
            }
            for (const profile of config.terminal?.profiles ?? []) {
                if (profile.sessionOptions) {
                    profile.options = profile.sessionOptions
                    delete profile.sessionOptions
                }
                profile.type = 'local'
                profile.id = `local:custom:${uuidv4()}`
            }
            if (config.terminal?.profiles) {
                config.profiles = config.terminal.profiles
                delete config.terminal.profiles
                delete config.terminal.environment
                delete config.terminal.profile
            }
        },
    },
    {
        version: 3,
        run: config => {
            delete config.ssh?.recentConnections
            for (const c of config.ssh?.connections ?? []) {
                const p = {
                    id: `ssh:${uuidv4()}`,
                    type: 'ssh',
                    icon: 'fas fa-desktop',
                    name: c.name,
                    group: c.group ?? undefined,
                    color: c.color,
                    disableDynamicTitle: c.disableDynamicTitle,
                    options: c,
                }
                config.profiles.push(p)
            }
            for (const p of config.profiles ?? []) {
                if (p.type === 'ssh') {
                    if (p.options.jumpHost) {
                        p.options.jumpHost = config.profiles.find(x => x.name === p.options.jumpHost)?.id
                    }
                }
            }
            for (const c of config.serial?.connections ?? []) {
                const p = {
                    id: `serial:${uuidv4()}`,
                    type: 'serial',
                    icon: 'fas fa-microchip',
                    name: c.name,
                    group: c.group ?? undefined,
                    color: c.color,
                    options: c,
                }
                config.profiles.push(p)
            }
            delete config.ssh?.connections
            delete config.serial?.connections
            delete window.localStorage.lastSerialConnection
        },
    },
    {
        version: 4,
        run: config => {
            for (const p of config.profiles ?? []) {
                if (!p.id) {
                    p.id = `${p.type}:custom:${uuidv4()}`
                }
            }
        },
    },
    {
        version: 5,
        run: config => {
            const groups: PartialProfileGroup<ProfileGroup>[] = []
            for (const p of config.profiles ?? []) {
                if (!(p.group ?? '').trim()) {
                    continue
                }

                let group = groups.find(x => x.name === p.group)
                if (!group) {
                    group = {
                        id: `${uuidv4()}`,
                        name: `${p.group}`,
                    }
                    groups.push(group)
                }
                p.group = group.id
            }

            const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
            for (const g of groups) {
                if (profileGroupCollapsed[g.name]) {
                    const collapsed = profileGroupCollapsed[g.name]
                    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                    delete profileGroupCollapsed[g.name]
                    profileGroupCollapsed[g.id] = collapsed
                }
            }
            window.localStorage.profileGroupCollapsed = JSON.stringify(profileGroupCollapsed)

            config.groups = groups
        },
    },
    {
        version: 6,
        run: config => {
            if (config.ssh?.clearServiceMessagesOnConnect === false) {
                config.profileDefaults ??= {}
                config.profileDefaults.ssh ??= {}
                config.profileDefaults.ssh.clearServiceMessagesOnConnect = false
                delete config.ssh?.clearServiceMessagesOnConnect
            }
        },
    },
    {
        version: 7,
        run: config => {
            if (!config.configSync?.host || config.configSync?.host === 'https://api.tabby.sh') {
                config.configSync ??= {}
                delete config.configSync.host
                delete config.configSync.token
            }
        },
    },
    {
        version: 8,
        run: config => {
            if (config.profileDefaults?.ssh?.options?.algorithms?.compression) {
                config.profileDefaults.ssh.options.algorithms.compression = ['none']
            }
            for (const p of config.profiles ?? []) {
                if (p.options?.algorithms?.compression) {
                    p.options.algorithms.compression = ['none']
                }
            }
        },
    },
    {
        version: 9,
        run: config => {
            // Workspace/session semantic consolidation
            if (config.recoverTabs !== undefined) {
                config.workspace ??= {}
                config.workspace.recoverTabs = config.recoverTabs
                delete config.recoverTabs
            }
            delete config.enableAutomaticUpdates
        },
    },
    {
        version: 10,
        run: config => {
            // Native window frame option was removed; the frame concept no
            // longer exists (only the thin custom frame is rendered).
            delete config.appearance?.frame
        },
    },
    {
        version: 11,
        run: config => {
            // Per-profile / per-provider / per-group hotkey namespaces were
            // never exposed in the UI and are dead (v3 removed builtin profiles).
            delete config.hotkeys?.profile
            delete config.hotkeys?.['profile-selectors']
            delete config.hotkeys?.['group-selectors']
        },
    },
    {
        version: 12,
        run: config => {
            // Hotkey ids renamed to match session granularity
            const remap = {
                'pane-nav-previous': 'session-nav-previous',
                'pane-nav-next': 'session-nav-next',
                'close-pane': 'close-session',
            }
            if (config.hotkeys) {
                for (const old of Object.keys(remap)) {
                    if (config.hotkeys[old] !== undefined) {
                        config.hotkeys[remap[old]] = config.hotkeys[old]
                        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                        delete config.hotkeys[old]
                    }
                }
            }
        },
    },
    {
        version: 13,
        run: config => {
            // Pane size +/- hotkeys were replaced by 8 splitter-move hotkeys
            for (const old of ['pane-increase-vertical', 'pane-decrease-vertical', 'pane-increase-horizontal', 'pane-decrease-horizontal']) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete config.hotkeys?.[old]
            }
        },
    },
    {
        version: 14,
        run: config => {
            // R3 cleanup: dead hotkey ns/keys and removed options that the
            // workspace & terminal refactor dropped but old saved configs
            // (and the v11-v13 migrations) still carry.
            for (const old of ['rearrange-panes', 'pane-maximize', 'pane-focus-all', 'focus-all-tabs', 'settings-tab']) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete config.hotkeys?.[old]
            }
            delete config.terminal?.showBuiltinProfiles
            delete config.enableAnalytics
        },
    },
    {
        version: 15,
        run: config => {
            // Frame-mode concept removed entirely: the app only renders the
            // thin custom frame (menus live in the title-bar hamburger now).
            delete config.appearance?.frame
        },
    },
]

const LATEST_VERSION = CONFIG_MIGRATIONS.length

function isStructuralMember (v): v is AnyRec {
    return v instanceof Object && !(v instanceof Array) &&
        Object.keys(v).length > 0 && !v.__nonStructural
}

function isNonStructuralObjectMember (v): boolean {
    return v instanceof Object && (v instanceof Array || v.__nonStructural)
}

// eslint-disable-next-line @typescript-eslint/no-type-alias
type AnyRec = Record<string, any>

// eslint-disable-next-line @typescript-eslint/no-type-alias
type IsRecord<T> = T extends object
    // eslint-disable-next-line @typescript-eslint/ban-types
    ? (T extends Function ? false : true)
    : false

// eslint-disable-next-line @typescript-eslint/no-type-alias
export type ProxifiedConfig<T extends AnyRec> = {
    [K in keyof T]:
    IsRecord<T[K]> extends true
        ? ProxifiedConfig<T[K]>   // structural -> nested proxy
        : T[K];                        // leaf -> original type
}

// eslint-disable-next-line @typescript-eslint/no-type-alias
export type FullyDefined<T> = T extends object
    ? { [K in keyof T]-?: FullyDefined<T[K]> }
    : T

/** @hidden */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ConfigProxy<T extends AnyRec> {
    constructor (real: Partial<T>, defaults: T) {
        for (const key in defaults) {
            if (isStructuralMember(defaults[key])) {
                if (!real[key]) {
                    real[key] = {} as any
                }
                const proxy = new ConfigProxy(real[key] as any, defaults[key])
                Object.defineProperty(
                    this,
                    key,
                    {
                        enumerable: true,
                        configurable: false,
                        get: () => proxy,
                    },
                )
            } else {
                Object.defineProperty(
                    this,
                    key,
                    {
                        enumerable: true,
                        configurable: false,
                        get: () => this.__getValue(key),
                        set: (value) => {
                            this.__setValue(key, value)
                        },
                    },
                )
            }
        }

        this.__getValue = (key: keyof T) => { // eslint-disable-line @typescript-eslint/unbound-method
            if (real[key] !== undefined) {
                return real[key]
            } else {
                if (isNonStructuralObjectMember(defaults[key])) {
                    // The object might be modified outside
                    real[key] = this.__getDefault(key)
                    delete real[key].__nonStructural
                    return real[key]
                }
                return this.__getDefault(key)
            }
        }

        this.__getDefault = (key: keyof T) => { // eslint-disable-line @typescript-eslint/unbound-method
            return deepClone(defaults[key])
        }

        this.__setValue = (key: keyof T, value: any) => { // eslint-disable-line @typescript-eslint/unbound-method
            if (deepEqual(value, this.__getDefault(key))) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete real[key]
            } else {
                real[key] = value
            }
        }

        this.__cleanup = () => { // eslint-disable-line @typescript-eslint/unbound-method
            // Trigger removal of default values
            for (const key in defaults) {
                if (isStructuralMember(defaults[key])) {
                    (this as any)[key].__cleanup()
                } else {
                    const v = this.__getValue(key)
                    this.__setValue(key, v)
                }
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-empty-function
    __getValue (_key: keyof T): any { }
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-empty-function
    __setValue (_key: keyof T, _value: any) { }
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-empty-function
    __getDefault (_key: keyof T): any { }
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-empty-function
    __cleanup () { }
}

// eslint-disable-next-line @typescript-eslint/no-type-alias, @typescript-eslint/no-redeclare
// export type ConfigProxy<T extends AnyRec> = ProxifiedConfig<T>

@Injectable({ providedIn: 'root' })
export class ConfigService {
    /**
     * Contains the actual config values
     */
    store: any

    /**
     * Whether an app restart is required due to recent changes
     */
    restartRequested: boolean

    /** Fires once when the config is loaded */
    get ready$ (): Observable<boolean> { return this.ready }

    private ready = new AsyncSubject<boolean>()
    private changed = new Subject<void>()
    private _store: any
    private defaults: any
    private servicesCache: Record<string, Function[]>|null = null // eslint-disable-line @typescript-eslint/ban-types

    get changed$ (): Observable<void> { return this.changed }

    /** @hidden */
    private constructor (
        private hostApp: HostAppService,
        private platform: PlatformService,
        private vault: VaultService,
        private translate: TranslateService,
        @Inject(ConfigProvider) private configProviders: ConfigProvider[],
        @Optional() @Inject(PLUGIN_MODULES) private pluginModules: any[]|null = null,
    ) {
        this.defaults = this.mergeDefaults()
        setTimeout(() => this.init())
        vault.contentChanged$.subscribe(() => {
            this.store.vault = vault.store
            this.save()
        })
        this.save = serializeFunction(this.save.bind(this))
    }

    mergeDefaults (): unknown {
        const providers = this.configProviders
        return providers.map(provider => {
            let defaults = provider.platformDefaults[this.hostApp.configPlatform] ?? {}
            defaults = configMerge(
                defaults,
                provider.platformDefaults[this.hostApp.platform] ?? {},
            )
            if (provider.defaults) {
                defaults = configMerge(provider.defaults, defaults)
            }
            return defaults
        }).reduce(configMergeByDefault)
    }

    getDefaults (): Record<string, any> {
        const cleanup = o => {
            if (o instanceof Array) {
                return o.map(cleanup)
            } else if (o instanceof Object) {
                const r = {}
                for (const k of Object.keys(o)) {
                    if (k !== '__nonStructural') {
                        r[k] = cleanup(o[k])
                    }
                }
                return r
            } else {
                return o
            }
        }
        return cleanup(this.defaults)
    }

    async load (): Promise<void> {
        const content = await this.platform.loadConfig()
        if (content) {
            this._store = yaml.load(content)
        } else {
            this._store = { version: LATEST_VERSION }
        }
        this._store = await this.maybeDecryptConfig(this._store)
        this.migrate(this._store)
        this.store = new ConfigProxy(this._store, this.defaults)
        this.vault.setStore(this.store.vault)
    }

    async save (): Promise<void> {
        await lastValueFrom(this.ready$)
        if (!this._store) {
            throw new Error('Cannot save an empty store')
        }
        // Scrub undefined values
        let cleanStore = JSON.parse(JSON.stringify(this._store))
        cleanStore = await this.maybeEncryptConfig(cleanStore)
        await this.platform.saveConfig(yaml.dump(cleanStore))
        this.emitChange()
    }

    /**
     * Reads config YAML as string
     */
    readRaw (): string {
        // Scrub undefined values
        const cleanStore = JSON.parse(JSON.stringify(this._store))
        return yaml.dump(cleanStore)
    }

    /**
     * Writes config YAML as string
     */
    async writeRaw (data: string): Promise<void> {
        this._store = yaml.load(data)
        await this.save()
        await this.load()
        this.emitChange()
    }

    requestRestart (): void {
        this.restartRequested = true
    }

    /**
     * Filters a list of Angular services to only include those provided
     * by plugins that are enabled
     *
     * @typeparam T Base provider type
     */
    enabledServices<T extends object> (services: T[]|undefined): T[] { // eslint-disable-line @typescript-eslint/ban-types
        if (!services) {
            return []
        }
        if (!this.servicesCache) {
            this.servicesCache = {}
            for (const imp of this.pluginModules ?? []) {
                const module = imp.ngModule || imp
                if (module.ɵinj?.providers) {
                    this.servicesCache[module.pluginName] = module.ɵinj.providers.map(provider => {
                        return provider.useClass ?? provider.useExisting ?? provider
                    })
                }
            }
        }
        return services.filter(service => {
            for (const pluginName in this.servicesCache) {
                if (this.servicesCache[pluginName].includes(service.constructor)) {
                    const id = `${pluginName}:${service.constructor.name}`
                    return !this.store?.pluginBlacklist?.includes(pluginName)
                        && !this.store?.providerBlacklist?.includes(id)
                }
            }
            return true
        })
    }

    private async init () {
        await this.load()
        this.ready.next(true)
        this.ready.complete()

        this.hostApp.configChangeBroadcast$.subscribe(async () => {
            await this.load()
            this.emitChange()
        })
    }

    private emitChange (): void {
        this.vault.setStore(this.store.vault)
        this.changed.next()
    }

    private migrate (config) {
        config.version ??= 0
        for (const { version, run } of CONFIG_MIGRATIONS) {
            if (config.version < version) {
                run(config)
                // Set the version only after the run succeeded, so a migration
                // that throws is re-attempted on the next boot instead of being
                // silently skipped.
                config.version = version
            }
        }
    }

    private async maybeDecryptConfig (store) {
        if (!store.encrypted) {
            return store
        }
        // eslint-disable-next-line @typescript-eslint/init-declarations
        let decryptedVault: Vault
        while (true) {
            try {
                const passphrase = await this.vault.getPassphrase()
                decryptedVault = await this.vault.decrypt(store.vault, passphrase)
                break
            } catch (e) {
                if (e.toString().includes('Vault unlock cancelled')) {
                    const cancelResult = await this.platform.showMessageBox({
                        type: 'warning',
                        message: this.translate.instant('Vault is locked'),
                        detail: this.translate.instant('The vault must be unlocked to load your configuration.'),
                        buttons: [
                            this.translate.instant('Try again'),
                            this.translate.instant('Quit'),
                        ],
                        defaultId: 0,
                        cancelId: 1,
                    })
                    if (cancelResult.response === 1) {
                        this.platform.quit()
                        return {}
                    }
                    continue
                }
                let result = await this.platform.showMessageBox({
                    type: 'error',
                    message: this.translate.instant('Could not decrypt config'),
                    detail: e.toString(),
                    buttons: [
                        this.translate.instant('Try again'),
                        this.translate.instant('Erase config'),
                        this.translate.instant('Quit'),
                    ],
                    defaultId: 0,
                })
                if (result.response === 2) {
                    this.platform.quit()
                }
                if (result.response === 1) {
                    result = await this.platform.showMessageBox({
                        type: 'warning',
                        message: this.translate.instant('Are you sure?'),
                        detail: e.toString(),
                        buttons: [
                            this.translate.instant('Erase config'),
                            this.translate.instant('Quit'),
                        ],
                        defaultId: 1,
                        cancelId: 1,
                    })
                    if (result.response === 1) {
                        this.platform.quit()
                    }
                    return {}
                }
            }
        }
        delete decryptedVault.config.vault
        delete decryptedVault.config.encrypted
        return {
            ...decryptedVault.config,
            vault: store.vault,
            encrypted: store.encrypted,
        }
    }

    private async maybeEncryptConfig (store) {
        if (!store.encrypted) {
            return store
        }
        const vault = await this.vault.load()
        if (!vault) {
            throw new Error('Vault not configured')
        }
        vault.config = { ...store }
        delete vault.config.vault
        delete vault.config.encrypted
        return {
            vault: await this.vault.encrypt(vault),
            encrypted: true,
        }
    }
}
