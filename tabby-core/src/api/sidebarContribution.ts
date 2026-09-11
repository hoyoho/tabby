/**
 * Extension point for the application sidebar.
 *
 * The sidebar is a public area: plugins can either take it over entirely
 * (`kind: 'owner'`) or add content to the built-in platform
 * (`kind: 'panel'` for a full page, `kind: 'widget'` for an inline block).
 *
 * Register a contribution with a multi-provider:
 *
 * ```ts
 * { provide: SidebarContribution, useClass: MySidebar, multi: true }
 * ```
 *
 * and return the Angular component to render from [[getComponentType]].
 * Components are created by the sidebar host, so they receive services through
 * DI like any other component.
 */

import { Type } from '@angular/core'

export type SidebarContributionKind = 'owner' | 'panel' | 'widget'

/**
 * Read-only information handed to [[SidebarContribution.isAvailable]] so a
 * contribution can decide whether it applies to the current session.
 */
export interface SidebarContext {
    /** Currently focused tab, if any. */
    activeTab?: unknown
}

export abstract class SidebarContribution {
    /** Unique id, also used to reference the contribution from settings. */
    abstract id: string

    /** Human-readable name, shown in switchers and settings. */
    title = ''

    /** Font Awesome icon class, used by the host when it needs a compact tab. */
    icon = ''

    /** Sort weight; lower comes first. */
    order = 0

    /**
     * `owner` replaces the whole sidebar, `panel` adds a full page to the
     * built-in platform, `widget` adds an inline block to it.
     */
    kind: SidebarContributionKind = 'panel'

    /**
     * Width hints, in px. Only meaningful for `panel`/`widget`; an `owner`
     * manages its own width. `maxWidth = 0` means "no specific maximum".
     */
    minWidth = 160
    defaultWidth = 250
    maxWidth = 0

    /** Whether this contribution should be offered right now. */
    isAvailable (ctx: SidebarContext): boolean { // eslint-disable-line @typescript-eslint/no-unused-vars
        return true
    }

    /** The component rendered for this contribution. */
    abstract getComponentType (): Type<unknown>
}
