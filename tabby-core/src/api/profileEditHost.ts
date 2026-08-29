import { ProfileProvider, PartialProfile, Profile, PartialProfileGroup, ProfileGroup } from './profileProvider'

export interface EditProfileOptions {
    partialProfile: PartialProfile<Profile>
    provider: ProfileProvider<Profile>
    /** When true, edits the group/global defaults rather than a concrete profile */
    defaultsMode?: 'enabled' | 'group'
}

export interface EditProfileGroupResult {
    group: PartialProfileGroup<ProfileGroup>
    provider?: ProfileProvider<Profile>
}

/**
 * UI operations that belong to a plugin (tabby-settings) but are needed by core.
 * Core defines the contract; the plugin provides the implementation via DI, so
 * core never has to hardcode plugin package names.
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export abstract class ProfileEditHost {
    abstract editProfile (options: EditProfileOptions): Promise<PartialProfile<Profile>|null>
    abstract editProfileGroup (
        group: PartialProfileGroup<ProfileGroup>,
        providers: ProfileProvider<Profile>[],
    ): Promise<EditProfileGroupResult|null>
    abstract openSettings (activeTab?: string): void
}
