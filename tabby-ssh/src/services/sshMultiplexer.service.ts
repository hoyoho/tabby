import { Injectable } from '@angular/core'
import { SSHProfile } from '../api'
import { PartialProfile, ProfilesService } from 'tabby-core'
import { SSHSession } from '../session/ssh'

@Injectable({ providedIn: 'root' })
export class SSHMultiplexerService {
    private sessions = new Map<string, SSHSession>()

    constructor (
        private profilesService: ProfilesService,
    ) { }

    async addSession (session: SSHSession): Promise<void> {
        // Quick-connect sessions (no profile id) are never pooled: every
        // quick-connect tab starts a fresh connective and authenticates on its own.
        if (!session.profile.id) {
            return
        }
        const key = await this.getMultiplexerKey(session.profile)
        this.sessions.set(key, session)
        session.willDestroy$.subscribe(() => {
            if (this.sessions.get(key) === session) {
                this.sessions.delete(key)
            }
        })
    }

    async getSession (profile: PartialProfile<SSHProfile>): Promise<SSHSession|null> {
        // Quick-connect profiles (no id) never reuse a pooled connection.
        if (!profile.id) {
            return null
        }
        const fullProfile = this.profilesService.getConfigProxyForProfile(profile)
        const key = await this.getMultiplexerKey(fullProfile)
        return this.sessions.get(key) ?? null
    }

    private async getMultiplexerKey (profile: SSHProfile) {
        // `auth` and the private-key list are part of the key: reusing an
        // already-authenticated connection regardless of the auth method would
        // silently keep using the old strategy after the user changes it.
        // The profile id is the basis of the key so that two different profiles
        // pointing at the same target never share a connection: each profile
        // authenticates with its own credentials.
        let key = `${profile.id}:${profile.options.host}:${profile.options.port}:${profile.options.user}:${profile.options.auth}:${profile.options.privateKeys.join(',')}:${profile.options.proxyCommand}:${profile.options.socksProxyHost}:${profile.options.socksProxyPort}:${profile.options.httpProxyHost}:${profile.options.httpProxyPort}`
        if (profile.options.jumpHost) {
            const jumpConnection = (await this.profilesService.getProfiles()).find(x => x.id === profile.options.jumpHost)
            if (!jumpConnection) {
                return key
            }
            const jumpProfile = this.profilesService.getConfigProxyForProfile<SSHProfile>(jumpConnection)
            key += '$' + await this.getMultiplexerKey(jumpProfile)
        }
        return key
    }
}
