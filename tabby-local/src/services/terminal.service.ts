import { Injectable } from '@angular/core'
import { Logger, LogService, ProfilesService, PartialProfile, SessionService } from 'tabby-core'
import { TerminalTabComponent } from '../components/terminalTab.component'
import { LocalProfile } from '../api'
import { isDirectorySync } from '../util'

@Injectable({ providedIn: 'root' })
export class TerminalService {
    private logger: Logger

    /** @hidden */
    private constructor (
        private profilesService: ProfilesService,
        private sessionService: SessionService,
        log: LogService,
    ) {
        this.logger = log.create('terminal')
    }

    async getDefaultProfile (): Promise<PartialProfile<LocalProfile>> {
        // The "default profile for new tabs" setting was removed: first local
        // profile is the single remaining fallback.
        const profiles = await this.profilesService.getProfiles()
        return profiles.filter(x => x.type === 'local')[0]
    }

    /**
     * Launches a new terminal with a specific shell and CWD
     * @param pause Wait for a keypress when the shell exits
     */
    async openTab (profile?: PartialProfile<LocalProfile>|null, cwd?: string|null, pause?: boolean): Promise<TerminalTabComponent|null> {
        // Called with no profile = the "new tab" action (hotkey / plus button):
        // the one place that continues in the focused session's directory.
        // Launching a named profile always honours that profile as configured.
        const inheritCwd = !profile

        if (!profile) {
            profile = await this.getDefaultProfile()
        }

        const fullProfile = this.profilesService.getConfigProxyForProfile(profile)

        cwd = cwd ?? fullProfile.options.cwd

        if (!cwd && inheritCwd) {
            cwd = await this.getFocusedSessionCwd()
        }

        if (cwd && !isDirectorySync(cwd)) {
            console.warn('Ignoring invalid CWD:', cwd)
            cwd = null
        }

        this.logger.info(`Starting profile ${fullProfile.name}`, fullProfile)
        const options = {
            ...fullProfile.options,
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
            pauseAfterExit: fullProfile.options.pauseAfterExit || pause,
            cwd: cwd ?? undefined,
        }

        return (await this.profilesService.openNewTabForProfile({
            ...fullProfile,
            options,
        })) as TerminalTabComponent|null
    }

    /**
     * Working directory of the focused session, or null when none is focused —
     * the target of the "new tab, same directory" action.
     */
    private async getFocusedSessionCwd (): Promise<string|null> {
        const focused = this.sessionService.getFocused()
        if (focused instanceof TerminalTabComponent && focused.session) {
            return await focused.session.getWorkingDirectory() ?? null
        }
        return null
    }
}
