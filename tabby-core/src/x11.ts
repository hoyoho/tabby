import type { SocketConnectOpts } from 'net'

/**
 * Resolve an X11 `DISPLAY` spec into a socket target.
 *
 * Shared by the renderer (settings preview) and the main process (actual X11
 * channel forwarding) so the two copies cannot drift again.
 */
export function resolveX11DisplaySpec (spec?: string|null): SocketConnectOpts {
    const match = /^(.+)?:(\d+)(?:\.(\d+))?$/.exec(spec ?? process.env.DISPLAY ?? 'localhost:0')
    const display = parseInt(match?.[2] ?? '0', 10)
    const port = display < 100 ? display + 6000 : display
    let xHost = match?.[1]

    if (process.platform === 'win32') {
        xHost ??= 'localhost'
    } else {
        xHost ??= 'unix'
    }

    if (spec?.startsWith('/')) {
        xHost = spec
    }

    if (xHost === 'unix') {
        xHost = `/tmp/.X11-unix/X${display}`
    }

    return xHost.startsWith('/') ? { path: xHost } : { host: xHost, port }
}
