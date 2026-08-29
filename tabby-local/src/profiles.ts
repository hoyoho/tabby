import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import deepClone from 'clone-deep'
import { Injectable, Inject } from '@angular/core'
import { ProfileProvider, NewTabParameters, ConfigService, WorkspaceComponent, AppService, PartialProfile } from 'tabby-core'
import { TerminalTabComponent } from './components/terminalTab.component'
import { LocalProfileSettingsComponent } from './components/localProfileSettings.component'
import { ShellProvider, Shell, SessionOptions, LocalProfile } from './api'

@Injectable({ providedIn: 'root' })
export class LocalProfilesService extends ProfileProvider<LocalProfile> {
    id = 'local'
    name = _('Local terminal')
    settingsComponent = LocalProfileSettingsComponent
    configDefaults = {
        options: {
            restoreFromPTYID: null,
            command: '',
            args: [],
            cwd: null,
            env: {
                __nonStructural: true,
            },
            width: null,
            height: null,
            shellType: null,
            pauseAfterExit: false,
            runAsAdministrator: false,
        },
    }

    constructor (
        private app: AppService,
        private config: ConfigService,
        @Inject(ShellProvider) private shellProviders: ShellProvider[],
    ) {
        super()
    }

    async getBuiltinProfiles (): Promise<PartialProfile<LocalProfile>[]> {
        const shells = await this.getShells()

        // Next a fixed set of terminal templates; the rest (cmder, cygwin,
        // msys2, …) is not offered — users can adapt a template's args instead.
        const pick = (match: RegExp): Shell|undefined => shells.find(x => match.test(x.name))
        const chosen = [
            pick(/^wsl\b/i) ?? pick(/wsl/i),
            pick(/^cmd\b/i) ?? pick(/cmd/i),
            pick(/powershell/i),
            pick(/git.*bash/i),
        ].filter(x => !!x) as Shell[]

        const templates = (chosen.length ? chosen : shells).map(shell => ({
            id: `local:${shell.id}`,
            type: 'local',
            name: shell.name,
            icon: shell.icon,
            options: this.optionsFromShell(shell),
            isBuiltin: true,
            isTemplate: true,
        }))
        return templates as PartialProfile<LocalProfile>[]
    }

    async getNewTabParameters (profile: LocalProfile): Promise<NewTabParameters<TerminalTabComponent>> {
        profile = deepClone(profile)

        if (!profile.options.cwd) {
            if (this.app.activeTab instanceof WorkspaceComponent) {
                const focusedTab = this.app.activeTab.getFocusedTab()

                if (focusedTab instanceof TerminalTabComponent && focusedTab.session) {
                    profile.options.cwd = await focusedTab.session.getWorkingDirectory() ?? null
                }
            }
        }

        return {
            type: TerminalTabComponent,
            inputs: {
                profile,
            },
        }
    }

    async getShells (): Promise<Shell[]> {
        const shellLists = await Promise.all(this.config.enabledServices(this.shellProviders).map(x => x.provide()))
        return shellLists.reduce((a, b) => a.concat(b), [])
    }

    optionsFromShell (shell: Shell): SessionOptions {
        return {
            ...this.configDefaults.options,
            command: shell.command,
            args: shell.args ?? [],
            env: shell.env,
            cwd: shell.cwd ?? null,
            shellType: shell.shellType ?? null,
        }
    }

    getSuggestedName (profile: LocalProfile): string {
        return this.getDescription(profile)
    }

    getDescription (profile: PartialProfile<LocalProfile>): string {
        return profile.options?.command ?? ''
    }
}
