export const BOOTSTRAP_DATA = 'BOOTSTRAP_DATA'

/**
 * Loaded plugin modules (Angular NgModules with a `pluginName` tag).
 * Provided at bootstrap by the host shell — replaces the old
 * `window['pluginModules']` global.
 */
export const PLUGIN_MODULES = 'PLUGIN_MODULES'

export interface PluginInfo {
    name: string
    description: string
    packageName: string
    isBuiltin: boolean
    isLegacy: boolean
    version: string
    author: string
    homepage?: string
    path?: string
    info?: any
    searchScore?: number
}

export interface BootstrapData {
    config: Record<string, any>
    executable: string
    isMainWindow: boolean
    windowID: number
    installedPlugins: PluginInfo[]
    userPluginsPath: string
}
