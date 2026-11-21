/**
 * Plugins that must never be offered for install: superseded, broken or now
 * bundled. Kept in core so both the main process and the plugin manager can
 * share one list without importing across package boundaries.
 */
export const PLUGIN_BLACKLIST = [
    'terminus-shell-selector', // superseded by profiles
    'terminus-scrollbar', // now useless
    'terminus-clickable-links', // now bundled with Tabby
    'tabby-clickable-links', // now bundled with Tabby
    'terminus-clickable-ips', // broken, functionality now bundled with Tabby
    'terminus-elastic-quick-commands', // broken and abandoned, fork of quick-commands
    'terminus-elastic-quick-cmds', // broken and abandoned, fork of quick-commands
    'tabby-fig', // abandoned,
    'tabby-plugin-fig-integration', // abandoned,
]
