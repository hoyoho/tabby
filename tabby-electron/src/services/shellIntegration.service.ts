import * as path from 'path'
import * as fs from 'mz/fs'
import { execFile } from 'mz/child_process'
import { firstValueFrom } from 'rxjs'
import { Injectable, Injector } from '@angular/core'
import { HostAppService, Platform, TranslateService, LocaleService, ConfigService } from 'tabby-core'
import { ElectronService } from '../services/electron.service'
import { Shell, ShellProvider, UACService } from 'tabby-local'

/* eslint-disable block-scoped-var */

try {
    var wnr = require('windows-native-registry') // eslint-disable-line @typescript-eslint/no-var-requires, no-var
} catch (_) { }

interface MenuEntry {
    shellId: string
    label: string
    admin?: boolean
}

@Injectable({ providedIn: 'root' })
export class ShellIntegrationService {
    private automatorWorkflows = ['Open Tabby here.workflow', 'Paste path into Tabby.workflow']
    private automatorWorkflowsLocation: string
    private automatorWorkflowsDestination: string

    private openLocations = [
        'Software\\Classes\\Directory\\Background\\shell\\Tabby',
        'SOFTWARE\\Classes\\Directory\\shell\\Tabby',
    ]
    private pasteLocation = 'Software\\Classes\\*\\shell\\Tabby'

    private localeRefreshBound = false

    private constructor (
        private electron: ElectronService,
        private hostApp: HostAppService,
        private translate: TranslateService,
        private injector: Injector,
    ) {
        if (this.hostApp.platform === Platform.macOS) {
            this.automatorWorkflowsLocation = path.join(
                path.dirname(path.dirname(this.electron.app.getPath('exe'))),
                'Resources',
                'extras',
                'automator-workflows',
            )
            this.automatorWorkflowsDestination = path.join(process.env.HOME!, 'Library', 'Services')
        }
        this.updatePaths()
    }

    /**
     * Resolve the locale lazily: LocaleService → ConfigService → PlatformService
     * forms a DI cycle on the construction path, so it can only be fetched once
     * the injector has finished hydrating ConfigService.
     */
    private getLocale (): LocaleService {
        return this.injector.get(LocaleService)
    }

    /**
     * Same lazy resolution for ShellProvider/UAC: eagerly injecting them here
     * pulls PowerShellCoreShellProvider (which depends on ConfigService) into
     * the ConfigService construction path and closes a DI cycle.
     */
    private getShellProviders (): ShellProvider[] {
        return this.injector.get(ShellProvider) as unknown as ShellProvider[]
    }

    private getUAC (): UACService|undefined {
        return this.injector.get(UACService, null) ?? undefined
    }

    private async ensureLocaleRefresh (): Promise<void> {
        if (this.localeRefreshBound) {
            return
        }
        this.localeRefreshBound = true
        // Defer past the synchronous bootstrap/DI hydrate pass, otherwise the
        // lazy resolver below would hit the same cycle mid-hydration.
        await Promise.resolve()
        this.getLocale().localeChanged$.subscribe(async () => {
            if (await this.isInstalled()) {
                this.install().catch(err => console.warn('[shell-integration] failed to refresh menu after locale change', err))
            }
        })
    }

    async isInstalled (): Promise<boolean> {
        if (this.hostApp.platform === Platform.macOS) {
            return fs.exists(path.join(this.automatorWorkflowsDestination, this.automatorWorkflows[0]))
        } else if (this.hostApp.platform === Platform.Windows) {
            return !!wnr.getRegistryKey(wnr.HK.CU, this.openLocations[0])
        }
        return true
    }

    async install (): Promise<void> {
        const exe: string = process.env.PORTABLE_EXECUTABLE_FILE ?? this.electron.app.getPath('exe')
        await this.ensureLocaleRefresh()
        if (this.hostApp.platform === Platform.macOS) {
            for (const wf of this.automatorWorkflows) {
                await execFile('cp', ['-r', path.join(this.automatorWorkflowsLocation, wf), this.automatorWorkflowsDestination])
            }
        } else if (this.hostApp.platform === Platform.Windows) {
            const shells = await this.getShells()
            const adminAvailable = !!this.getUAC()?.isAvailable
            for (const location of this.openLocations) {
                await this.writeOpenMenu(location, exe, shells, adminAvailable)
            }
            await this.writePasteMenu(this.pasteLocation, exe)

            // Clean up leftovers from older versions
            if (wnr.getRegistryKey(wnr.HK.CU, 'Software\\Classes\\Directory\\Background\\shell\\Open Tabby here')) {
                wnr.deleteRegistryKey(wnr.HK.CU, 'Software\\Classes\\Directory\\Background\\shell\\Open Tabby here')
            }
            if (wnr.getRegistryKey(wnr.HK.CU, 'Software\\Classes\\*\\shell\\Paste path into Tabby')) {
                wnr.deleteRegistryKey(wnr.HK.CU, 'Software\\Classes\\*\\shell\\Paste path into Tabby')
            }
        }
    }

    async remove (): Promise<void> {
        if (this.hostApp.platform === Platform.macOS) {
            for (const wf of this.automatorWorkflows) {
                await execFile('rm', ['-rf', path.join(this.automatorWorkflowsDestination, wf)])
            }
        } else if (this.hostApp.platform === Platform.Windows) {
            for (const location of [...this.openLocations, this.pasteLocation]) {
                wnr.deleteRegistryKey(wnr.HK.CU, location)
            }
        }
    }

    private async writeOpenMenu (location: string, exe: string, shells: Shell[], adminAvailable: boolean): Promise<void> {
        // Rebuild from scratch so stale entries for uninstalled shells go away
        wnr.deleteRegistryKey(wnr.HK.CU, location)
        wnr.createRegistryKey(wnr.HK.CU, location)

        // Official cascading-menu model (Windows 7+): a cascading item uses an
        // empty (Default), a MUIVerb for its label and an ExtendedSubCommandsKey
        // pointing at the HKCR-relative location whose `shell` subkeys become
        // the submenu. Plain static `shell\verb` nesting is not rendered as a
        // submenu by Explorer.
        wnr.setRegistryValue(wnr.HK.CU, location, '', wnr.REG.SZ, '')
        wnr.setRegistryValue(wnr.HK.CU, location, 'MUIVerb', wnr.REG.SZ, this.translate.instant('Open Tabby here'))
        wnr.setRegistryValue(wnr.HK.CU, location, 'Icon', wnr.REG.SZ, exe)
        wnr.setRegistryValue(wnr.HK.CU, location, 'ExtendedSubCommandsKey', wnr.REG.SZ, location.replace(/^Software\\Classes\\/, ''))

        const entries: MenuEntry[] = []
        const seen = new Set<string>()
        for (const shell of shells) {
            if (shell.hidden || shell.id === 'default' || seen.has(shell.id)) {
                continue
            }
            seen.add(shell.id)
            entries.push({
                shellId: shell.id,
                label: shell.name,
            })
        }

        const baseEntries = [...entries]
        if (adminAvailable) {
            for (const e of baseEntries) {
                entries.push({
                    shellId: e.shellId,
                    label: this.translate.instant('{name} (as admin)', { name: e.label }),
                    admin: true,
                })
            }
        }

        entries.forEach((entry, index) => {
            const verb = `${String(index).padStart(2, '0')}-${this.sanitizeVerbName(entry.shellId)}`
            const verbPath = `${location}\\shell\\${verb}`
            wnr.createRegistryKey(wnr.HK.CU, verbPath)
            wnr.setRegistryValue(wnr.HK.CU, verbPath, '', wnr.REG.SZ, '')
            wnr.setRegistryValue(wnr.HK.CU, verbPath, 'MUIVerb', wnr.REG.SZ, entry.label)

            const commandPath = `${verbPath}\\command`
            wnr.createRegistryKey(wnr.HK.CU, commandPath)
            const command = `${this.quote(exe)} open --profile=${entry.shellId}${entry.admin ? ' --admin' : ''} --directory="%V"`
            wnr.setRegistryValue(wnr.HK.CU, commandPath, '', wnr.REG.SZ, command)
        })
    }

    private async writePasteMenu (location: string, exe: string): Promise<void> {
        wnr.deleteRegistryKey(wnr.HK.CU, location)
        wnr.createRegistryKey(wnr.HK.CU, location)
        wnr.setRegistryValue(wnr.HK.CU, location, '', wnr.REG.SZ, this.translate.instant('Paste path into Tabby'))
        wnr.setRegistryValue(wnr.HK.CU, location, 'Icon', wnr.REG.SZ, exe)

        const commandPath = `${location}\\command`
        wnr.createRegistryKey(wnr.HK.CU, commandPath)
        wnr.setRegistryValue(wnr.HK.CU, commandPath, '', wnr.REG.SZ, `${this.quote(exe)} paste "%V"`)
    }

    private async getShells (): Promise<Shell[]> {
        // Providers read config.store (env vars etc.), which is only populated
        // once ConfigService.load() finishes; updatePaths() can call install()
        // during construction, so gate enumeration on config readiness.
        const config = this.injector.get(ConfigService)
        await firstValueFrom(config.ready$)
        const shellLists = await Promise.all(this.getShellProviders().map(x => x.provide()))
        return shellLists.reduce((a, b) => a.concat(b), [])
    }

    private sanitizeVerbName (id: string): string {
        return id.replace(/[^a-zA-Z0-9_-]/g, '')
    }

    private quote (p: string): string {
        return `"${p}"`
    }

    private async updatePaths (): Promise<void> {
        // Update paths in case of an update
        if (this.hostApp.platform === Platform.Windows) {
            if (await this.isInstalled()) {
                await this.install()
            }
        }
    }
}
