import * as fs from 'fs'
import * as tls from 'tls'

let cachedPems: string[]|null = null

/**
 * Windows trust store via win-ca ("root" = trusted root CAs, including
 * GPO-deployed enterprise CAs; "ca" = intermediates). Electron runs it in
 * fallback mode automatically, so no native N-API surprises.
 */
function dumpWindowsCertificates (): string[] {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const winca = require('win-ca/api')
    const pems: string[] = []
    winca({
        store: ['root', 'ca'],
        format: winca.der2.pem,
        ondata: pems,
    })
    return pems
}

/**
 * macOS keychains via mac-ca (SystemRootCertificates + user keychains,
 * deduplicated, certs already bundled with Node excluded).
 */
function dumpMacOSCertificates (): string[] {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const macCa = require('mac-ca')
    return macCa.get({ format: macCa.Format.pem }) as string[]
}

function extractPems (output: string): string[] {
    return output.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
}

/**
 * Linux: OpenSSL-style CA bundles at their well-known locations.
 */
function readLinuxBundles (): string[] {
    const paths = [
        '/etc/ssl/certs/ca-certificates.crt',
        '/etc/pki/tls/certs/ca-bundle.crt',
        '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
        '/etc/pki/tls/cacert.pem',
        '/etc/ssl/ca-bundle.pem',
    ]
    for (const bundlePath of paths) {
        try {
            const pems = extractPems(fs.readFileSync(bundlePath, 'utf8'))
            if (pems.length) {
                return pems
            }
        } catch {
            // Try the next bundle location
        }
    }
    return []
}

/**
 * Node.js ignores the OS certificate store and ships its own Mozilla CA
 * list, so corporate TLS inspection (re-signing traffic with a CA that
 * only exists in the system store) fails with "self signed certificate
 * in certificate chain". Enumerate the system trust store and return the
 * certificates as PEM strings; empty on failure.
 */
export async function getSystemCertificates (): Promise<string[]> {
    if (cachedPems) {
        return cachedPems
    }
    try {
        if (process.platform === 'win32') {
            cachedPems = dumpWindowsCertificates()
        } else if (process.platform === 'darwin') {
            cachedPems = dumpMacOSCertificates()
        } else {
            cachedPems = readLinuxBundles()
        }
    } catch {
        cachedPems = []
    }
    return cachedPems
}

/**
 * CA list with "append" semantics: Node's bundled Mozilla roots plus
 * whatever the OS trust store holds. Returns undefined when the system
 * store yields nothing, letting callers keep the default behavior.
 */
export async function getTrustedCertificates (): Promise<string[]|undefined> {
    const system = await getSystemCertificates()
    if (!system.length) {
        return undefined
    }
    return [...tls.rootCertificates, ...system]
}
