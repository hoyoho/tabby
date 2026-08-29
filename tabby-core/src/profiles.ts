import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import slugify from 'slugify'
import { v4 as uuidv4 } from 'uuid'
import { Injectable } from '@angular/core'
import { ConfigService, NewTabParameters, PartialProfile, Profile, ProfileProvider } from './api'
import { WorkspaceComponent } from './components/workspace.component'

export interface SplitLayoutProfileOptions {
    recoveryToken: any
}

export interface SplitLayoutProfile extends Profile {
    options: SplitLayoutProfileOptions
}

@Injectable({ providedIn: 'root' })
export class SplitLayoutProfilesService extends ProfileProvider<SplitLayoutProfile> {
    id = 'split-layout'
    name = _('Saved layout')
    configDefaults = {
        options: {
            recoveryToken: null,
        },
    }

    constructor (
        private config: ConfigService,
    ) {
        super()
    }

    async getBuiltinProfiles (): Promise<PartialProfile<SplitLayoutProfile>[]> {
        return []
    }

    async getNewTabParameters (profile: SplitLayoutProfile): Promise<NewTabParameters<WorkspaceComponent>> {
        return {
            type: WorkspaceComponent,
            inputs: {
                _recoveredState: profile.options.recoveryToken,
                _profileName: profile.name,
            },
        }
    }

    getDescription (): string {
        return ''
    }

    async createProfile (tab: WorkspaceComponent, name: string): Promise<void> {
        const token = await tab.getRecoveryToken({ includeState: false })
        const profile: PartialProfile<SplitLayoutProfile> = {
            id: `${this.id}:custom:${slugify(name)}:${uuidv4()}`,
            type: this.id,
            name,
            options: {
                recoveryToken: token,
            },
        }
        this.config.store.profiles.push(profile)
        await this.config.save()
    }
}
