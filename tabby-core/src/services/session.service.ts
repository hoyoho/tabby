import { Injectable } from '@angular/core'
import { SessionTab } from '../api/session'
import { WorkspaceComponent } from '../components/workspace.component'
import { TabsService } from './tabs.service'
import { AppService } from './app.service'
import { ProfilesService } from './profiles.service'
import { PartialProfile, Profile } from '../api/profileProvider'

/**
 * Single place for "session" operations (the unit that actually runs a
 * connection). Sessions always live inside a WorkspaceComponent; this service
 * centralises how the focused session is found and how profiles are applied.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
    constructor (
        private app: AppService,
        private profiles: ProfilesService,
        private tabs: TabsService,
    ) { }

    /**
     * The focused session, if any. A top-level workspace exposes its focused
     * child; a session can never itself be a top-level tab (R0/R1 invariant),
     * so only the workspace arm is reachable.
     */
    getFocused (): SessionTab|null {
        const tab = this.app.activeTab
        if (tab instanceof WorkspaceComponent) {
            const focused = tab.getFocusedTab()
            return focused instanceof SessionTab ? focused : null
        }
        return null
    }

    /** Launch a session from a profile and record it in the recent list. */
    async launch (profile: PartialProfile<Profile>): Promise<void> {
        // Thin forward: the open-target decision (focused pane vs new
        // workspace) lives in AppService.openNewTab; kept here as the
        // session-oriented entry point.
        await this.profiles.launchProfile(profile)
    }

    /**
     * Let the user pick another session profile and replace `session` in place.
     * Layout profiles (split-layout) are excluded — they cannot replace a
     * single session inside a workspace.
     */
    async switchProfile (session: SessionTab): Promise<void> {
        const profile = await this.profiles
            .showProfileSelector(p => p.type !== 'split-layout')
            .catch(() => null)
        if (!profile) {
            return
        }

        const params = await this.profiles.newTabParametersForProfile(profile)
        if (!params) {
            return
        }

        if (!await session.canClose()) {
            return
        }

        const parent = session.parent
        if (!(parent instanceof WorkspaceComponent)) {
            return
        }

        const newTab = this.tabs.create(params)
        try {
            parent.replaceTab(session, newTab)
        } catch (e) {
            // Don't leak an orphan session if the in-place swap blows up.
            newTab.destroy()
            throw e
        }

        session.destroy()
    }
}
