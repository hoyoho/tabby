import { PartialProfile, Profile, PartialProfileGroup, ProfileGroup } from './profileProvider'

/**
 * Context handed to [[ProfileTreeItemProvider]] for a single profile row.
 */
export interface ProfileTreeItemContext {
    profile: PartialProfile<Profile>
    group?: PartialProfileGroup<ProfileGroup>
}

/**
 * Extension point for per-row augmentation of the profile tree.
 *
 * A plugin can contribute hover text (e.g. a connection summary: host, user,
 * port) for profile rows. Register it as a multi-provider:
 *
 * ```ts
 * { provide: ProfileTreeItemProvider, useClass: MyProvider, multi: true }
 * ```
 *
 * The host renders the returned lines as a multi-line tooltip on the row.
 * Providers that do not apply to a given profile return an empty array.
 */
export abstract class ProfileTreeItemProvider {
    /** Unique id. */
    abstract id: string

    /** Sort weight; lower comes first. */
    order = 0

    /** Whether this provider applies to the given profile. */
    isAvailable (ctx: ProfileTreeItemContext): boolean { // eslint-disable-line @typescript-eslint/no-unused-vars
        return true
    }

    /** Hover lines for the row. Empty for no tooltip. */
    getTooltip (ctx: ProfileTreeItemContext): string[] { // eslint-disable-line @typescript-eslint/no-unused-vars
        return []
    }
}
