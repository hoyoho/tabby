import { resolveX11DisplaySpec } from 'tabby-core'

/**
 * Kept as an object for plugin compatibility; the resolver itself now lives in
 * `tabby-core` so the main and renderer processes share one implementation.
 */
export const X11Socket = {
    resolveDisplaySpec: resolveX11DisplaySpec,
}
