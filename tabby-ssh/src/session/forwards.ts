import { ForwardedPortConfig, PortForwardType } from '../api'

/**
 * Renderer-side data object for one forwarded port. The actual local TCP
 * listeners live in the main process (`app/lib/ssh.ts`); this only mirrors
 * their config for the UI.
 */
export class ForwardedPort implements ForwardedPortConfig {
    type: PortForwardType
    host = '127.0.0.1'
    port: number
    targetAddress: string
    targetPort: number
    description: string

    toString (): string {
        if (this.type === PortForwardType.Local) {
            return `(local) ${this.host}:${this.port} → (remote) ${this.targetAddress}:${this.targetPort}`
        } if (this.type === PortForwardType.Remote) {
            return `(remote) ${this.host}:${this.port} → (local) ${this.targetAddress}:${this.targetPort}`
        } else {
            return `(dynamic) ${this.host}:${this.port}`
        }
    }
}
