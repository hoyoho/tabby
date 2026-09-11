import * as path from 'path'
import * as fs from 'mz/fs'
import { Injectable } from '@angular/core'
import { CLIHandler, CLIEvent, HostWindowService, ProfilesService, NotificationsService, PlatformService, TranslateService, PartialProfile } from 'tabby-core'
import { TerminalService } from './services/terminal.service'
import { LocalProfile } from './api'
import { LocalProfilesService } from './profiles'

@Injectable()
export class TerminalCLIHandler extends CLIHandler {
    firstMatchOnly = true
    priority = 0

    constructor (
        private hostWindow: HostWindowService,
        private terminal: TerminalService,
        private profiles: ProfilesService,
        private localProfiles: LocalProfilesService,
        private platform: PlatformService,
        private translate: TranslateService,
    ) {
        super()
    }

    async handle (event: CLIEvent): Promise<boolean> {
        const op = event.argv._[0]

        if (op === 'open') {
            this.handleOpenDirectory(path.resolve(event.cwd, event.argv.directory!), event.argv.profile, event.argv.admin)
        } else if (op === 'run') {
            await this.handleRunCommand(event.argv.command!)
        } else {
            return false
        }

        return true
    }

    private async handleOpenDirectory (directory: string, profileName?: string, admin?: boolean) {
        if (directory.length > 1 && (directory.endsWith('/') || directory.endsWith('\\'))) {
            directory = directory.substring(0, directory.length - 1)
        }
        if (!await fs.exists(directory)) {
            return
        }
        if (!(await fs.stat(directory)).isDirectory()) {
            return
        }

        let profile: PartialProfile<LocalProfile>|null = null
        if (profileName) {
            profile = (await this.profiles.getProfiles()).find(x =>
                x.id === profileName || x.id === `local:${profileName}` || x.name === profileName,
            ) as PartialProfile<LocalProfile>|null ?? null
            profile ??= await this.localProfiles.getLocalProfileByShellId(profileName)
        }
        if (!profile) {
            profile = await this.terminal.getDefaultProfile()
        }
        if (admin) {
            profile = {
                ...profile,
                options: {
                    ...profile.options,
                    runAsAdministrator: true,
                },
            }
        }
        this.terminal.openTab(profile, directory)
        this.hostWindow.bringToFront()
    }

    private async handleRunCommand (command: string[]) {
        if ((await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant(`Run "{command}"?`, { command: command.join(' ') }),
            buttons: [
                this.translate.instant('Run'),
                this.translate.instant('Cancel'),
            ],
            defaultId: 0,
            cancelId: 1,
        })).response === 1) {
            return
        }

        this.terminal.openTab({
            type: 'local',
            name: '',
            options: {
                command: command[0],
                args: command.slice(1),
            },
        }, null, true)
        this.hostWindow.bringToFront()
    }
}


@Injectable()
export class OpenPathCLIHandler extends CLIHandler {
    firstMatchOnly = true
    priority = -100

    constructor (
        private terminal: TerminalService,
        private profiles: ProfilesService,
        private hostWindow: HostWindowService,
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) {
        super()
    }

    async handle (event: CLIEvent): Promise<boolean> {
        const op = event.argv._[0]
        const opAsPath = op ? path.resolve(event.cwd, op) : null

        const profile = await this.terminal.getDefaultProfile()

        if (opAsPath && await fs.exists(opAsPath) && (await fs.lstat(opAsPath)).isDirectory()) {
            this.terminal.openTab(profile, opAsPath)
            this.hostWindow.bringToFront()
            return true
        }

        if (opAsPath && await fs.exists(opAsPath)) {
            if (opAsPath.endsWith('.sh') || opAsPath.endsWith('.command')) {
                profile.options!.pauseAfterExit = true
                profile.options?.args?.push(opAsPath)
                this.terminal.openTab(profile)
                this.hostWindow.bringToFront()
                return true
            } else if (opAsPath.endsWith('.bat')) {
                const psProfile = (await this.profiles.getProfiles()).find(x => x.id === 'cmd')
                if (psProfile) {
                    psProfile.options!.pauseAfterExit = true
                    psProfile.options?.args?.push(opAsPath)
                    this.terminal.openTab(psProfile)
                    this.hostWindow.bringToFront()
                    return true
                }
            } else if (opAsPath.endsWith('.ps1')) {
                const cmdProfile = (await this.profiles.getProfiles()).find(x => x.id === 'powershell')
                if (cmdProfile) {
                    cmdProfile.options!.pauseAfterExit = true
                    cmdProfile.options?.args?.push(opAsPath)
                    this.terminal.openTab(cmdProfile)
                    this.hostWindow.bringToFront()
                    return true
                }
            } else {
                this.notifications.error(this.translate.instant('Cannot handle scripts of this type'))
            }
        }

        return false
    }
}
