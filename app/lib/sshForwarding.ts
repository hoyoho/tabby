import * as net from 'net'
import socksv5 from '@luminati-io/socksv5'

export interface ForwardedPortConfig {
    type: 'Local'|'Remote'|'Dynamic'
    host: string
    port: number
    targetAddress: string
    targetPort: number
    description: string
}

/** Local TCP listener for a forwarded port; lives in the main process. */
export class ForwardedPort implements ForwardedPortConfig {
    type: ForwardedPortConfig['type']
    host = '127.0.0.1'
    port: number
    targetAddress: string
    targetPort: number
    description: string

    private listener: net.Server|null = null

    async startLocalListener (callback: (accept: () => net.Socket, reject: () => void, sourceAddress: string|null, sourcePort: number|null, targetAddress: string, targetPort: number) => void): Promise<void> {
        if (this.type === 'Local') {
            const listener = this.listener = net.createServer(s => callback(
                () => s,
                () => s.destroy(),
                s.remoteAddress ?? null,
                s.remotePort ?? null,
                this.targetAddress,
                this.targetPort,
            ))
            return new Promise((resolve, reject) => {
                listener.listen(this.port, this.host)
                listener.on('error', reject)
                listener.on('listening', resolve)
            })
        } else if (this.type === 'Dynamic') {
            return new Promise((resolve, reject) => {
                this.listener = socksv5.createServer((info, acceptConnection, rejectConnection) => {
                    callback(
                        () => acceptConnection(true),
                        () => rejectConnection(),
                        null,
                        null,
                        info.dstAddr,
                        info.dstPort,
                    )
                }) as net.Server
                this.listener.on('error', reject)
                this.listener.listen(this.port, this.host, resolve)
                // eslint-disable-next-line dot-notation
                this.listener['useAuth'](socksv5.auth.None())
            })
        } else {
            throw new Error('Invalid forward type for a local listener')
        }
    }

    stopLocalListener (): void {
        this.listener?.close()
    }

    toString (): string {
        if (this.type === 'Local') {
            return `(local) ${this.host}:${this.port} → (remote) ${this.targetAddress}:${this.targetPort}`
        } if (this.type === 'Remote') {
            return `(remote) ${this.host}:${this.port} → (local) ${this.targetAddress}:${this.targetPort}`
        } else {
            return `(dynamic) ${this.host}:${this.port}`
        }
    }
}

/** Adapter so the manager can rebuild a ForwardedPort from an IPC config. */
export class ForwardedPortHost extends ForwardedPort {
    constructor (config: ForwardedPortConfig) {
        super()
        Object.assign(this, config)
    }
}
