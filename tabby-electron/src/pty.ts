import * as psNode from 'ps-node'
import { Injectable, NgZone } from '@angular/core'
import { ipcRenderer } from 'electron'
import { ChildProcess, PTYInterface, PTYProxy } from 'tabby-local'
import { getWorkingDirectoryFromPID } from 'native-process-working-directory'

/* eslint-disable block-scoped-var */

try {
    var macOSNativeProcessList = require('macos-native-processlist')  // eslint-disable-line @typescript-eslint/no-var-requires, no-var
} catch { }

try {
    var windowsProcessTree = require('@tabby-gang/windows-process-tree')  // eslint-disable-line @typescript-eslint/no-var-requires, no-var
} catch { }

/**
 * Resolves with `fallback` if `promise` does not settle within `ms`.
 *
 * The pid/process-tree/working-directory probes below talk to optional native
 * modules that can simply never call back (invalid pid, module not built,
 * process in a weird state). Left unbounded, one of those hangs would keep a
 * pending await alive in the Angular zone and freeze that window's change
 * detection — so every probe is bounded here.
 */
function withTimeout<T> (promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>(resolve => {
        const timer = setTimeout(() => resolve(fallback), ms)
        promise.then(
            value => {
                clearTimeout(timer)
                resolve(value)
            },
            () => {
                clearTimeout(timer)
                resolve(fallback)
            },
        )
    })
}

@Injectable()
export class ElectronPTYInterface extends PTYInterface {
    constructor (private zone: NgZone) {
        super()
    }

    async spawn (...options: any[]): Promise<PTYProxy> {
        const id = ipcRenderer.sendSync('pty:spawn', ...options)
        return new ElectronPTYProxy(id, this.zone)
    }

    async restore (id: string): Promise<ElectronPTYProxy|null> {
        // Claims ownership of a live PTY (cross-window transfer). The generic
        // `pty:attach` endpoint mirrors serial/telnet.
        if (ipcRenderer.sendSync('pty:attach', id)) {
            return new ElectronPTYProxy(id, this.zone)
        }
        return null
    }
}

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ElectronPTYProxy extends PTYProxy {
    private subscriptions: Map<string, any> = new Map()
    private truePID: Promise<number>

    constructor (
        private id: string,
        private zone: NgZone,
    ) {
        super()
        // Resolve the "true" shell pid in the background — deliberately OUTSIDE
        // the Angular zone: it is UI-irrelevant bookkeeping, and if a native
        // probe ever hangs it must not freeze this window's change detection.
        this.truePID = this.zone.runOutsideAngular(() => new Promise(async (resolve) => {
            let pid = await this.getPID()
            try {
                await new Promise(r => setTimeout(r, 2000))

                // Retrieve any possible single children now that shell has fully started
                let processes = await this.getChildProcessesInternal(pid)
                // Bounded walk (a malformed/cyclic tree must not spin forever).
                let guard = 0
                while (pid && processes.length === 1 && guard++ < 64) {
                    if (!processes[0].pid) {
                        break
                    }
                    pid = processes[0].pid
                    processes = await this.getChildProcessesInternal(pid)
                }
            } finally {
                resolve(pid)
            }
        }))
        this.truePID = this.truePID.catch(() => this.getPID())
    }

    getID (): string {
        return this.id
    }

    getTruePID (): Promise<number> {
        return this.truePID
    }

    async getPID (): Promise<number> {
        // The pid is only known once the PTY host has spawned the process, so
        // this must be async (a sync IPC would race the host). Bounded so a
        // host that never reports cannot hang the caller.
        return withTimeout(ipcRenderer.invoke('pty:get-pid', this.id), 5000, 0)
    }

    subscribe (event: string, handler: (..._: any[]) => void): void {
        const key = `pty:${this.id}:${event}`
        const newHandler = (_event, ...args) => handler(...args)
        this.subscriptions.set(key, newHandler)
        ipcRenderer.on(key, newHandler)
    }

    ackData (length: number): void {
        ipcRenderer.send('pty:ack-data', this.id, length)
    }

    unsubscribeAll (): void {
        for (const k of this.subscriptions.keys()) {
            ipcRenderer.off(k, this.subscriptions.get(k))
        }
        // Notify the main process that this window no longer owns the PTY so
        // a kept-alive (dragged) session enters the abandonment countdown.
        ipcRenderer.send('pty:detach', this.id)
    }

    async resize (columns: number, rows: number): Promise<void> {
        ipcRenderer.send('pty:resize', this.id, columns, rows)
    }

    async write (data: Buffer): Promise<void> {
        ipcRenderer.send('pty:write', this.id, data)
    }

    async kill (signal?: string): Promise<void> {
        ipcRenderer.send('pty:kill', this.id, signal)
    }

    async getChildProcesses (): Promise<ChildProcess[]> {
        return this.getChildProcessesInternal(await this.getTruePID())
    }

    async getChildProcessesInternal (truePID: number): Promise<ChildProcess[]> {
        if (!truePID) {
            return []
        }
        if (process.platform === 'darwin') {
            return withTimeout((async () => {
                const processes = await macOSNativeProcessList.getProcessList()
                return processes.filter(x => x.ppid === truePID).map(p => ({
                    pid: p.pid,
                    ppid: p.ppid,
                    command: p.name,
                }))
            })(), 3000, [])
        }
        if (process.platform === 'win32') {
            // windows-process-tree is an optional native dep; when it is not
            // installed/built (or the pty is already gone) the probe must not
            // blow up the renderer with an unhandled rejection.
            if (!windowsProcessTree) {
                return []
            }
            return withTimeout(new Promise<ChildProcess[]>(resolve => {
                windowsProcessTree.getProcessTree(truePID, tree => {
                    resolve(tree ? tree.children.map(child => ({
                        pid: child.pid,
                        ppid: tree.pid,
                        command: child.name,
                    })) : [])
                })
            }), 3000, [])
        }
        return withTimeout(new Promise<ChildProcess[]>((resolve, reject) => {
            psNode.lookup({ ppid: truePID }, (err, processes) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve(processes as ChildProcess[])
            })
        }), 3000, [])
    }

    async getWorkingDirectory (): Promise<string|null> {
        const pid = await this.getTruePID()
        if (!pid) {
            return null
        }
        return withTimeout(Promise.resolve(getWorkingDirectoryFromPID(pid)), 3000, null)
    }

}
