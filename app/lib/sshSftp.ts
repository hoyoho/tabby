import { v4 as uuidv4 } from 'uuid'
import * as russh from 'russh'

interface SFTPEntry {
    sftp: russh.SFTP
    handles: Map<string, russh.SFTPFile>
}

/**
 * Owns one SSH connection's shared SFTP channel plus the per-renderer handles
 * opened on top of it. Extracted from `SSHConnection` so the SFTP protocol
 * surface (open/close/op/handle IO) is separate from the connection's auth,
 * forwarding and channel-pump responsibilities.
 */
export class SFTPSessionRegistry {
    private sftps = new Map<string, SFTPEntry>()
    private mainSftp: russh.SFTP|null = null
    private mainSftpOpening: Promise<russh.SFTP>|null = null

    /**
     * @param onClosed invoked once per renderer context when the shared SFTP
     * channel closes; a listener may synchronously reopen, so the registry is
     * cleared before these fire.
     */
    constructor (private onClosed: (id: string) => void) { }

    async open (client: russh.AuthenticatedSSHClient): Promise<string> {
        if (!this.mainSftp) {
            this.mainSftpOpening ??= this.openMainSftp(client).finally(() => {
                this.mainSftpOpening = null
            })
            await this.mainSftpOpening
        }
        if (!this.mainSftp) {
            throw new Error('SFTP session closed right after opening')
        }
        const id = uuidv4().toString()
        this.sftps.set(id, { sftp: this.mainSftp, handles: new Map() })
        return id
    }

    /** Release one renderer's SFTP context without closing the shared channel. */
    close (sftpId: string): void {
        const entry = this.sftps.get(sftpId)
        if (!entry) {
            return
        }
        this.sftps.delete(sftpId)
        for (const handle of entry.handles.values()) {
            void handle.shutdown().catch(() => undefined)
        }
        entry.handles.clear()
    }

    async op (sftpId: string, op: string, args: any[]): Promise<any> {
        const sftp = this.getSftp(sftpId)
        switch (op) {
            case 'readdir': {
                const [p] = args
                const entries = await sftp.readDirectory(p)
                return entries.map(entry => ({
                    name: entry.name,
                    isDirectory: entry.metadata.type === russh.SFTPFileType.Directory,
                    isSymlink: entry.metadata.type === russh.SFTPFileType.Symlink,
                    mode: entry.metadata.permissions ?? 0,
                    size: entry.metadata.size,
                    mtime: entry.metadata.mtime ?? 0,
                }))
            }
            case 'readlink':
                return sftp.readlink(args[0])
            case 'stat': {
                const stats = await sftp.stat(args[0])
                return {
                    isDirectory: stats.type === russh.SFTPFileType.Directory,
                    isSymlink: stats.type === russh.SFTPFileType.Symlink,
                    mode: stats.permissions ?? 0,
                    size: stats.size,
                    mtime: stats.mtime ?? 0,
                }
            }
            case 'open': {
                const [p, mode] = args
                const handle = await sftp.open(p, mode)
                const handleId = uuidv4().toString()
                this.sftps.get(sftpId)!.handles.set(handleId, handle)
                return handleId
            }
            case 'rmdir':
                return sftp.removeDirectory(args[0])
            case 'mkdir':
                return sftp.createDirectory(args[0])
            case 'rename':
                return sftp.rename(args[0], args[1])
            case 'unlink':
                return sftp.removeFile(args[0])
            case 'chmod':
                return sftp.chmod(args[0], args[1])
            default:
                throw new Error(`Unknown SFTP op: ${op}`)
        }
    }

    async readHandle (sftpId: string, handleId: string): Promise<Buffer> {
        const handle = this.sftps.get(sftpId)?.handles.get(handleId)
        if (!handle) {
            throw new Error('File handle is closed')
        }
        return Buffer.from(await handle.read(256 * 1024))
    }

    async writeHandle (sftpId: string, handleId: string, chunk: Uint8Array): Promise<void> {
        const handle = this.sftps.get(sftpId)?.handles.get(handleId)
        if (!handle) {
            throw new Error('File handle is closed')
        }
        await handle.writeAll(chunk)
    }

    async closeHandle (sftpId: string, handleId: string): Promise<void> {
        const handle = this.sftps.get(sftpId)?.handles.get(handleId)
        if (!handle) {
            return
        }
        this.sftps.get(sftpId)!.handles.delete(handleId)
        try {
            await handle.shutdown()
        } catch { /* already gone */ }
    }

    /** Drops every renderer context; used when the enclosing connection tears down. */
    dispose (): void {
        this.sftps.clear()
        this.mainSftp = null
        this.mainSftpOpening = null
    }

    private async openMainSftp (client: russh.AuthenticatedSSHClient): Promise<russh.SFTP> {
        const channel = await client.openSessionChannel()
        // NewChannel cannot be closed from JS: if activateSFTP() rejects, the
        // native layer owns the channel and cleans it up with the connection.
        const sftp = await client.activateSFTP(channel)
        this.mainSftp = sftp
        sftp.closed$.subscribe(() => {
            if (this.mainSftp === sftp) {
                this.mainSftp = null
            }
            const closedIds = [...this.sftps.keys()]
            this.sftps.clear()
            // Clear before emitting so a listener may synchronously reopen.
            for (const id of closedIds) {
                this.onClosed(id)
            }
        })
        return sftp
    }

    private getSftp (id: string): russh.SFTP {
        const entry = this.sftps.get(id)
        if (!entry) {
            throw new Error('SFTP session is closed')
        }
        return entry.sftp
    }
}
