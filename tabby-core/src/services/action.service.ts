import { Injectable, Inject } from '@angular/core'
import { Action, ActionContext, ActionProvider, ActionSurface, AsyncActionProvider } from '../api/action'

/**
 * Central action registry (R3). All UI surfaces read from here:
 *   menu bar, tab context menus, toolbars, command palette.
 * Providers contribute Actions; each Action opts into the surfaces it wants.
 * Legacy providers are adapted onto this interface by core.
 */
@Injectable({ providedIn: 'root' })
export class ActionRegistry {
    constructor (
        @Inject(ActionProvider) private providers: ActionProvider[],
    ) { }

    /**
     * Returns actions for the given surface, merged across providers, sorted
     * by weight (stable) with later duplicate ids winning.
     */
    get (surface: ActionSurface, ctx: ActionContext = {}): Action[] {
        return this.merge(surface, ctx, this.providers.map(p => p.provide(ctx)))
    }

    /**
     * Async variant for surfaces whose actions may be computed from awaited
     * context (tab context menus, commands). Falls back to the sync path for
     * providers that are not AsyncActionProvider.
     */
    async getAsync (surface: ActionSurface, ctx: ActionContext = {}): Promise<Action[]> {
        const lists: Action[][] = []
        for (const provider of this.providers) {
            if (provider instanceof AsyncActionProvider) {
                lists.push(await provider.provideAsync(ctx))
            } else {
                lists.push(provider.provide(ctx))
            }
        }
        return this.merge(surface, ctx, lists)
    }

    private merge (surface: ActionSurface, ctx: ActionContext, lists: Action[][]): Action[] {
        const merged = new Map<string, Action>()
        const ordered: Action[] = []

        for (const list of lists) {
            for (const action of list ?? []) {
                if (!action.surfaces.includes(surface)) {
                    continue
                }
                if (action.type === 'separator') {
                    ordered.push(action)
                    continue
                }
                if (action.id && merged.has(action.id)) {
                    merged.set(action.id, action)
                } else {
                    merged.set(action.id ?? `_anon_${ordered.length}`, action)
                }
            }
        }

        for (const action of merged.values()) {
            ordered.push(action)
        }

        return ordered.sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0))
    }

    isEnabled (action: Action, ctx: ActionContext): boolean {
        return action.enabled ? action.enabled(ctx) : true
    }

    run (action: Action, ctx: ActionContext): void {
        void action.run(ctx)
    }
}