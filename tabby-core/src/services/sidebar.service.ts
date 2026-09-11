import { Injectable, Inject, Optional } from '@angular/core'
import { AppService } from './app.service'
import { SidebarContribution, SidebarContributionKind, SidebarContext } from '../api/sidebarContribution'

/**
 * Aggregates [[SidebarContribution]]s registered by plugins and tells the
 * sidebar host what to render: a single `owner` that replaces the whole area,
 * or the `panel`/`widget` contributions that extend the built-in platform.
 */
@Injectable({ providedIn: 'root' })
export class SidebarService {
    constructor (
        @Optional() private app: AppService|null,
        @Optional() @Inject(SidebarContribution) private contributions: SidebarContribution[]|null,
    ) { }

    private get all (): SidebarContribution[] {
        if (!this.contributions) {
            return []
        }
        return Array.isArray(this.contributions) ? this.contributions : [this.contributions]
    }

    get context (): SidebarContext {
        return { activeTab: this.app?.activeTab }
    }

    private available (kind: SidebarContributionKind): SidebarContribution[] {
        const ctx = this.context
        return this.all
            .filter(c => c.kind === kind && c.isAvailable(ctx))
            .sort((a, b) => a.order - b.order)
    }

    /** The contribution that takes over the whole sidebar, if any. */
    get owner (): SidebarContribution|null {
        return this.available('owner')[0] ?? null
    }

    /** Full pages contributed to the built-in sidebar platform. */
    get panels (): SidebarContribution[] {
        return this.available('panel')
    }

    /** Inline blocks contributed to the built-in sidebar platform. */
    get widgets (): SidebarContribution[] {
        return this.available('widget')
    }
}
