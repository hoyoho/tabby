import * as fs from 'mz/fs'
import * as fsSync from 'fs'
import { Injector } from '@angular/core'
import { HostAppService, ConfigService, WIN_BUILD_CONPTY_SUPPORTED, isWindowsBuild, Platform, BootstrapData, BOOTSTRAP_DATA, LogService } from 'tabby-core'
import { BaseSession } from 'tabby-terminal'
import { SessionOptions, ChildProcess, PTYInterface, PTYProxy } from './api'
import { getEnvironment, substituteEnv } from './environment'

const windowsDirectoryRegex = /([a-zA-Z]:[^\:\[\]\?\"\<\>\|]+)/mi

function mergeEnv (...envs) {
    const result = {}
    const keyMap = {}
    for (const env of envs) {
        for (const [key, value] of Object.entries(env)) {
            // const lookup = process.platform === 'win32' ? key.toLowerCase() : key
            const lookup = key.toLowerCase()
            keyMap[lookup] ??= key
            result[keyMap[lookup]] = value
        }
    }
    return result
}

/** @hidden */
export class Session extends BaseSession {
    private pty: PTYProxy|null = null
    private ptyClosed = false
    private pauseAfterExit = false
    private destroying = false
    private guessedCWD: string|null = null
    private initialCWD: string|null = null
    private config: ConfigService
    private hostApp: HostAppService
    private bootstrapData: BootstrapData
    private ptyInterface: PTYInterface

    /**
     * When set, destroy() tears down this session's listeners/state but keeps
     * the underlying PTY alive in the main process. Used when a workspace is
     * moved to a new window: the new window re-attaches the same PTY by its id
     * via `restoreFromPTYID`, so the shell (and any running job) must not be
     * killed on the way out.
     */
    keepPTYAlive = false

    constructor (
        injector: Injector,
    ) {
        super(injector.get(LogService).create('local'))
        this.config = injector.get(ConfigService)
        this.hostApp = injector.get(HostAppService)
        this.ptyInterface = injector.get(PTYInterface)
        this.bootstrapData = injector.get(BOOTSTRAP_DATA)
    }

    async start (options: SessionOptions): Promise<void> {
        let pty: PTYProxy|null = null

        if (options.restoreFromPTYID) {
            pty = await this.ptyInterface.restore(options.restoreFromPTYID)
            options.restoreFromPTYID = null
        }

        if (!pty) {
            const baseEnv = getEnvironment(
                this.hostApp.platform === Platform.Windows && this.config.store.terminal.windowsRefreshEnvironment,
            )

            let env = mergeEnv(
                baseEnv,
                {
                    COLORTERM: 'truecolor',
                    TERM: 'xterm-256color',
                    TERM_PROGRAM: 'Tabby',
                },
                substituteEnv(options.env),
                this.config.store.terminal.environment || {},
            )

            if (this.hostApp.platform === Platform.Windows && this.config.store.terminal.setComSpec) {
                env = mergeEnv(env, { COMSPEC: this.bootstrapData.executable })
            }

            delete env['']

            if (this.hostApp.platform === Platform.macOS && !process.env.LC_ALL) {
                const locale = process.env.LC_CTYPE ?? 'en_US.UTF-8'
                Object.assign(env, {
                    LANG: locale,
                    LC_ALL: locale,
                    LC_MESSAGES: locale,
                    LC_NUMERIC: locale,
                    LC_COLLATE: locale,
                    LC_MONETARY: locale,
                })
            }

            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
            let cwd = options.cwd || process.env.HOME

            // WSL launchers (system32 wsl.exe / bash.exe) never inherit the
            // Windows working directory — the distro always starts in the
            // default user's home. Forward the requested directory explicitly
            // via `--cd`, which accepts both Linux and Windows paths.
            let wslCdArgs: string[] = []
            if (this.hostApp.platform === Platform.Windows && options.cwd) {
                const exe = options.command.toLowerCase()
                if (exe.endsWith('\\system32\\wsl.exe') || exe === 'wsl.exe' || exe.endsWith('\\system32\\bash.exe')) {
                    wslCdArgs = ['--cd', options.cwd]
                    if (!fsSync.existsSync(options.cwd)) {
                        // Linux-side path: keep the ConPTY process in a real
                        // Windows directory, the real cwd rides on --cd.
                        cwd = process.env.USERPROFILE ?? process.env.HOME
                    }
                }
            }

            if (!fsSync.existsSync(cwd!)) {
                console.warn('Ignoring non-existent CWD:', cwd)
                cwd = undefined
            }

            pty = await this.ptyInterface.spawn(options.command, [...wslCdArgs, ...options.args], {
                name: 'xterm-256color',
                cols: options.width ?? 80,
                rows: options.height ?? 30,
                encoding: null,
                cwd,
                env: env,
                // `1` instead of `true` forces ConPTY even if unstable
                useConpty: isWindowsBuild(WIN_BUILD_CONPTY_SUPPORTED) && this.config.store.terminal.useConPTY ? 1 : false,
            })

            this.guessedCWD = cwd ?? null
        }

        this.pty = pty

        pty.getTruePID().then(async () => {
            this.initialCWD = await this.getWorkingDirectory()
        })

        this.open = true

        this.pty.subscribe('data', (array: Uint8Array) => {
            this.pty!.ackData(array.length)
            const data = Buffer.from(array)
            this.emitOutput(data)
            if (this.hostApp.platform === Platform.Windows) {
                this.guessWindowsCWD(data.toString())
            }
        })

        this.pty.subscribe('exit', () => {
            if (this.pauseAfterExit) {
                return
            } else if (this.open) {
                this.destroy()
            }
        })

        this.pty.subscribe('close', () => {
            this.ptyClosed = true
            if (this.pauseAfterExit) {
                this.emitOutput(Buffer.from('\r\nPress any key to close\r\n'))
            } else if (this.open) {
                this.destroy()
            }
        })

        this.pauseAfterExit = options.pauseAfterExit

        this.destroyed$.subscribe(() => this.pty!.unsubscribeAll())
    }

    getID (): string|null {
        return this.pty?.getID() ?? null
    }

    resize (columns: number, rows: number): void {
        this.pty?.resize(columns, rows)
    }

    write (data: Buffer): void {
        if (this.ptyClosed) {
            this.destroy()
        }
        if (this.open) {
            this.pty?.write(data)
        }
    }

    kill (signal?: string): void {
        this.pty?.kill(signal)
    }

    override async destroy (): Promise<void> {
        if (this.destroying) {
            return
        }
        this.destroying = true
        if (this.keepPTYAlive) {
            // Detach without killing the live PTY: drop our listeners/subjects
            // so the shell keeps running in the main process for the new window.
            this.pty?.unsubscribeAll()
            this.open = false
            this.middleware.close()
            this.closed.next()
            this.destroyed.next()
            this.closed.complete()
            this.destroyed.complete()
            this.output.complete()
            this.binaryOutput.complete()
            this.pty = null
            return
        }
        // ConPTY hosts are fragile when torn down with an active child. Give the
        // shell a graceful exit to finish first so outer shells (WSL/Git Bash,
        // plain cmd with clink, etc.) don't crash the renderer/main on close —
        // which looked like a second app instance being started.
        if (this.hostApp.platform === Platform.Windows && this.open && !this.ptyClosed) {
            const pty = this.pty
            try {
                pty?.write(Buffer.from('\r\nexit\r\n'))
            } catch { /* ignore */ }
            if (pty) {
                await new Promise<void>(resolve => {
                    let settled = false
                    const timer = setTimeout(() => {
                        settled = true
                        resolve()
                    }, 2000)
                    const finish = (): void => {
                        if (!settled) {
                            settled = true
                            clearTimeout(timer)
                            resolve()
                        }
                    }
                    pty.subscribe('exit', finish)
                    pty.subscribe('close', finish)
                })
            }
        }
        await super.destroy()
        try {
            if (this.pty && !this.ptyClosed) {
                this.pty.kill()
            }
        } catch { /* ignore */ }
        this.pty = null
    }

    async getChildProcesses (): Promise<ChildProcess[]> {
        return this.pty?.getChildProcesses() ?? []
    }

    async gracefullyKillProcess (): Promise<void> {
        if (this.hostApp.platform === Platform.Windows) {
            this.kill()
        } else {
            await new Promise<void>((resolve) => {
                this.kill('SIGTERM')
                setTimeout(async () => {
                    try {
                        process.kill(await this.pty!.getPID(), 0)
                        // still alive
                        this.kill('SIGKILL')
                        resolve()
                    } catch {
                        resolve()
                    }
                }, 500)
            })
        }
    }

    supportsWorkingDirectory (): boolean {
        return !!(this.initialCWD ?? this.reportedCWD ?? this.guessedCWD)
    }

    async getWorkingDirectory (): Promise<string|null> {
        if (this.reportedCWD) {
            return this.reportedCWD
        }
        let cwd: string|null = null
        try {
            cwd = await this.pty?.getWorkingDirectory() ?? null
        } catch (exc) {
            // PTY process is already gone (e.g. after a session was killed or
            // right when it starts) — nothing to report, don't spam the console.
            if (/NtQueryInformationProcess|invalid process handle|not found|no such process/i.test(exc instanceof Error ? exc.message : String(exc))) {
                return null
            }
            this.logger.debug('Could not read working directory:', exc)
        }

        try {
            cwd = await fs.realpath(cwd)
        } catch {}

        if (this.hostApp.platform === Platform.Windows && (cwd === this.initialCWD || cwd === process.env.WINDIR)) {
            // shell doesn't truly change its process' CWD
            cwd = null
        }

        cwd = cwd ?? this.guessedCWD

        try {
            await fs.access(cwd)
        } catch {
            return null
        }
        return cwd
    }

    private guessWindowsCWD (data: string) {
        const match = windowsDirectoryRegex.exec(data)
        if (match) {
            this.guessedCWD = match[0]
        }
    }
}
