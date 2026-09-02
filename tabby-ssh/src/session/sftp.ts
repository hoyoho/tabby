import { ipcRenderer } from 'electron'
import { Subject, Observable } from 'rxjs'
import { posix as posixPath } from 'path'
import { FileDownload, FileUpload } from 'tabby-core'
import { SSHSession } from './ssh'

// Mirrors russh's SFTP open flags — the file opens happen in the main
// process, the renderer only needs the numeric values.
export const OPEN_READ = 1
export const OPEN_WRITE = 2
export const OPEN_APPEND = 4
export const OPEN_CREATE = 8
export const OPEN_TRUNCATE = 16

export interface SFTPFile {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    mode: number
    size: number
    modified: Date
}

interface SFTPEntryMetadata {
    name: string
    isDirectory: boolean
    isSymlink: boolean
    mode: number
    size: number
    mtime: number
}

export class SFTPFileHandle {
    position = 0

    constructor (
        private connId: string,
        private sftpId: string,
        public id: string,
    ) { }

    async read (): Promise<Uint8Array> {
        return await ipcRenderer.invoke('ssh:sftp-handle-read', this.connId, this.sftpId, this.id)
    }

    async write (chunk: Uint8Array): Promise<void> {
        await ipcRenderer.invoke('ssh:sftp-handle-write', this.connId, this.sftpId, this.id, chunk)
    }

    async close (): Promise<void> {
        await ipcRenderer.invoke('ssh:sftp-handle-close', this.connId, this.sftpId, this.id).catch(() => undefined)
    }
}

/**
 * Proxy over a main-process SFTP context. All operations round-trip through
 * IPC; chunked transfers reuse the same 256K block size as before.
 */
export class SFTPSession {
    get closed$ (): Observable<void> { return this.closed }
    private closed = new Subject<void>()
    private connId: string|null
    private sftpId: string|null = null

    constructor (private ssh: SSHSession) {
        this.connId = ssh.getID()
    }

    /** Must be awaited once before any operation; returns this for chaining. */
    async init (): Promise<this> {
        this.sftpId = await this.ssh.createSFTPId()
        this.ssh.subscribeSFTPClosed(this.sftpId, () => {
            this.closed.next()
            this.closed.complete()
        })
        return this
    }

    static async create (ssh: SSHSession): Promise<SFTPSession> {
        const session = new SFTPSession(ssh)
        await session.init()
        return session
    }

    private async op (name: string, ...args: any[]): Promise<any> {
        if (!this.connId || !this.sftpId) {
            throw new Error('SFTP session is closed')
        }
        return ipcRenderer.invoke('ssh:sftp-op', this.connId, this.sftpId, name, args)
    }

    async readdir (p: string): Promise<SFTPFile[]> {
        const entries: SFTPEntryMetadata[] = await this.op('readdir', p)
        return entries.map(entry => ({
            fullPath: posixPath.join(p, entry.name),
            name: entry.name,
            isDirectory: entry.isDirectory,
            isSymlink: entry.isSymlink,
            mode: entry.mode,
            size: entry.size,
            modified: new Date(entry.mtime * 1000),
        }))
    }

    async readlink (p: string): Promise<string> {
        return this.op('readlink', p)
    }

    async stat (p: string): Promise<SFTPFile> {
        const stats: SFTPEntryMetadata = await this.op('stat', p)
        return {
            name: posixPath.basename(p),
            fullPath: p,
            isDirectory: stats.isDirectory,
            isSymlink: stats.isSymlink,
            mode: stats.mode,
            size: stats.size,
            modified: new Date(stats.mtime * 1000),
        }
    }

    async open (p: string, mode: number): Promise<SFTPFileHandle> {
        const handleId: string = await this.op('open', p, mode)
        return new SFTPFileHandle(this.connId!, this.sftpId!, handleId)
    }

    async rmdir (p: string): Promise<void> {
        await this.op('rmdir', p)
    }

    async mkdir (p: string): Promise<void> {
        await this.op('mkdir', p)
    }

    async rename (oldPath: string, newPath: string): Promise<void> {
        await this.op('rename', oldPath, newPath)
    }

    async unlink (p: string): Promise<void> {
        await this.op('unlink', p)
    }

    async chmod (p: string, mode: string|number): Promise<void> {
        await this.op('chmod', p, mode)
    }

    async upload (path: string, transfer: FileUpload): Promise<void> {
        const tempPath = path + '.tabby-upload'
        try {
            const handle = await this.open(tempPath, OPEN_WRITE | OPEN_CREATE)
            while (true) {
                const chunk = await transfer.read()
                if (!chunk.length) {
                    break
                }
                await handle.write(chunk)
            }
            await handle.close()
            await this.unlink(path).catch(() => null)
            await this.rename(tempPath, path)
            transfer.close()
        } catch (e) {
            transfer.cancel()
            await this.unlink(tempPath).catch(() => null)
            throw e
        }
    }

    async download (path: string, transfer: FileDownload): Promise<void> {
        try {
            const handle = await this.open(path, OPEN_READ)
            while (true) {
                const chunk = await handle.read()
                if (!chunk.length) {
                    break
                }
                await transfer.write(chunk)
            }
            transfer.close()
            await handle.close()
        } catch (e) {
            transfer.cancel()
            throw e
        }
    }
}
