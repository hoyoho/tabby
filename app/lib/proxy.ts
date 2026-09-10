import * as https from 'https'
import { app, session } from 'electron'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

import { getTrustedCertificates } from './systemCertificates'

export interface ProxyConfig {
    mode?: string
    host?: string
    username?: string
    password?: string
}

export interface ProxyTestResult {
    ok: boolean
    ms: number
    status?: number
    error?: string
}

/** Latest proxy config, kept in sync by applyProxy() for the auth handler. */
let activeProxy: ProxyConfig = {}

interface ProxyEndpoint {
    scheme: 'http'|'https'|'socks5'
    host: string
    port: number
    /** Full URL including credentials, for the npm proxy agents. */
    url: string
}

/**
 * Resolve the manual proxy settings into a concrete endpoint. The scheme
 * is inferred from the address prefix (`socks5://` → SOCKS5, `https://` →
 * HTTPS proxy, anything else — including bare addresses and `http://` — →
 * HTTP). The port is part of the address (e.g. `http://127.0.0.1:8080`)
 * and is required; an address without one is invalid. Pasted userinfo
 * (`user:pass@`) is discarded in favor of the dedicated auth fields.
 */
function resolveProxyEndpoint (proxy: ProxyConfig): ProxyEndpoint|null {
    if (proxy.mode !== 'manual' || !proxy.host) {
        return null
    }
    let address = proxy.host.trim()
    let scheme: 'http'|'https'|'socks5' = 'http'
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(address)
    if (schemeMatch) {
        if (/^socks5?$/i.test(schemeMatch[1])) {
            scheme = 'socks5'
        } else if (/^https$/i.test(schemeMatch[1])) {
            scheme = 'https'
        }
        address = address.slice(schemeMatch[0].length)
    }
    const atIndex = address.lastIndexOf('@')
    if (atIndex !== -1) {
        address = address.slice(atIndex + 1)
    }
    address = address.replace(/\/.*$/, '')
    let port = 0
    const portMatch = /^(.+):(\d+)$/.exec(address)
    if (portMatch && (!portMatch[1].includes(':') || portMatch[1].startsWith('['))) {
        address = portMatch[1]
        port = parseInt(portMatch[2], 10)
    }
    if (!address || !port) {
        return null
    }
    const auth = proxy.username
        ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
        : ''
    return {
        scheme,
        host: address,
        port,
        url: `${scheme}://${auth}${address}:${port}`,
    }
}

/**
 * Build Chromium proxy rules for the "manual" mode, e.g. `127.0.0.1:8080`,
 * `https://127.0.0.1:8443` or `socks5://127.0.0.1:1080`. Returns null when
 * manual proxy is not usable (disabled or incomplete config).
 */
export function buildProxyRules (proxy: ProxyConfig): string|null {
    const endpoint = resolveProxyEndpoint(proxy)
    if (!endpoint) {
        return null
    }
    if (endpoint.scheme === 'socks5') {
        return `socks5://${endpoint.host}:${endpoint.port}`
    }
    if (endpoint.scheme === 'https') {
        return `https://${endpoint.host}:${endpoint.port}`
    }
    return `${endpoint.host}:${endpoint.port}`
}

/**
 * Register the app-level auth handler answering proxy credential
 * challenges (Chromium ignores credentials embedded in proxy rules).
 * Must be called once, before any proxied request can happen.
 */
export function registerProxyAuthHandler (): void {
    app.on('login', (event, _webContents, _details, authInfo, callback) => {
        if (!authInfo.isProxy) {
            return
        }
        console.log(`Proxy auth challenge from ${authInfo.host}:${authInfo.port} (scheme: ${authInfo.scheme})`)
        if (activeProxy.mode !== 'manual' || !activeProxy.username) {
            return
        }
        event.preventDefault()
        callback(activeProxy.username, activeProxy.password ?? '')
    })
}

/**
 * Apply the user's proxy settings to the default session, which covers
 * every renderer network request (plugin search, web content, etc.).
 *
 * Three modes: automatic (follow the OS proxy settings, the default),
 * direct (bypass any proxy) and manual (fixed proxy rules).
 *
 * Must only be called after the app `ready` event.
 */
export async function applyProxy (configStore: { proxy?: ProxyConfig }|null|undefined): Promise<void> {
    activeProxy = configStore?.proxy ?? {}
    const rules = buildProxyRules(activeProxy)
    try {
        if (rules) {
            await session.defaultSession.setProxy({
                proxyRules: rules,
                proxyBypassRules: '<local>',
            })
        } else if (activeProxy.mode === 'direct') {
            await session.defaultSession.setProxy({ mode: 'direct' })
        } else {
            await session.defaultSession.setProxy({ mode: 'system' })
        }
    } catch (err) {
        console.error('Failed to apply proxy settings', err)
    }
}

/**
 * Network options for @npmcli/arborist (plugin installs): proxy URL with
 * embedded credentials when manual mode is active (the underlying
 * http(s)/socks agents read user:pass from the URL), plus the system
 * certificate store so TLS-intercepting corporate networks work.
 * Returns an empty object when there is nothing to override (direct or
 * system mode), letting npm fall back to environment variables /
 * direct connection.
 */
export async function getArboristNetworkOptions (configStore: { proxy?: ProxyConfig }|null|undefined): Promise<Record<string, unknown>> {
    const options: Record<string, unknown> = {}
    const endpoint = resolveProxyEndpoint(configStore?.proxy ?? {})
    if (endpoint) {
        options.proxy = endpoint.url
        options.httpsProxy = endpoint.url
    }
    const ca = await getTrustedCertificates()
    if (ca) {
        options.ca = ca
    }
    return options
}

/**
 * Probe the plugin registry the same way a plugin installation does:
 * from the main process, through the very same proxy agent stack
 * (@npmcli/agent), with credentials embedded in the proxy URL. This
 * deliberately bypasses Chromium's auth cache and Windows transparent
 * NTLM logon, so it reflects what plugin installs will actually do.
 *
 * In direct and automatic modes the request goes out directly (what npm
 * does when no proxy env vars are set).
 */
export async function testProxyConnection (configStore: { proxy?: ProxyConfig }|null|undefined): Promise<ProxyTestResult> {
    const proxy = configStore?.proxy ?? {}
    const endpoint = resolveProxyEndpoint(proxy)
    // An incomplete manual config must not silently fall back to a direct
    // (or anything-but-the-configured-proxy) connection — report it instead.
    if (proxy.mode === 'manual' && !endpoint) {
        console.error('Proxy test aborted: manual proxy is not fully configured')
        return {
            ok: false,
            ms: 0,
            error: 'EMPTY_PROXY',
        }
    }
    const started = Date.now()
    const agent = endpoint
        ? endpoint.scheme === 'socks5'
            ? new SocksProxyAgent(endpoint.url)
            : new HttpsProxyAgent(endpoint.url)
        : undefined
    const ca = await getTrustedCertificates()

    return new Promise<ProxyTestResult>(resolve => {
        const request = https.get(
            'https://registry.npmjs.com/-/ping',
            { agent, ca, timeout: 10000 },
            response => {
                response.resume()
                response.on('end', () => {
                    const status = response.statusCode ?? 0
                    resolve({
                        ok: status === 200,
                        ms: Date.now() - started,
                        status,
                        error: status === 200 ? undefined : `HTTP ${status}`,
                    })
                })
            },
        )
        request.on('timeout', () => request.destroy(new Error('Connection timed out')))
        request.on('error', err => {
            const message = err instanceof Error ? err.message : String(err)
            resolve({
                ok: false,
                ms: Date.now() - started,
                error: message.includes('407') ? `${message} (proxy authentication failed - check username/password)` : message,
            })
        })
    })
}
