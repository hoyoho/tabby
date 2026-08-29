import { Injectable, Inject, Optional } from '@angular/core'
import { Action, ActionContext, ActionProvider, ActionSurface, AsyncActionProvider } from './action'
import { AppMenuItem, MenuProvider } from './menuProvider'
import { ToolbarButtonProvider } from './toolbarButtonProvider'
import { TabContextMenuItemProvider } from './tabContextMenuProvider'
import { MenuItemOptions } from './menu'
import { Command, CommandLocation, CommandProvider } from './commands'
import { ConfigService } from '../services/config.service'

/**
 * Shared enabled/checked/run mapping for a legacy menu item. Both the menu-bar
 * and the tab-context adapters need the exact same three guards; the only
 * differences between them live in the surrounding itemToAction.
 */
function commonMenuItemParts (item: { enabled?: boolean, checked?: boolean, click?: () => void }): Pick<Action, 'enabled'|'checked'|'run'> {
    return {
        enabled: item.enabled === undefined ? undefined : () => item.enabled === true,
        checked: item.checked === undefined ? undefined : () => item.checked === true,
        run: () => {
            if (item.enabled !== false) {
                item.click?.()
            }
        },
    }
}

/**
 * Adapts the legacy MenuProvider contract onto the R3 Action model so the
 * menu bar reads from the unified registry while old providers keep working.
 */
@Injectable()
export class MenuActionAdapter extends ActionProvider {
    constructor (
        @Inject(MenuProvider) private menuProviders: MenuProvider[],
    ) {
        super()
    }

    provide (_ctx: ActionContext): Action[] {
        const topLevel: Action[] = []
        const contributions: { target: string, items: Action[] }[] = []

        for (const provider of this.menuProviders) {
            for (const menu of provider.getMenus()) {
                const menuId = `menu:${provider.constructor.name}:${menu.label}`
                // Positional ids keep every child unique across providers and
                // menus, so the registry's id merge never collapses two items
                // that merely share a label.
                const children = menu.items.map((item, itemIndex) => this.itemToAction(item, `${menuId}:${itemIndex}`))
                if (menu.target) {
                    contributions.push({ target: menu.target, items: children })
                    continue
                }
                topLevel.push({
                    id: menuId,
                    label: menu.label,
                    weight: (menu.weight ?? 0) + provider.weight,
                    surfaces: [ActionSurface.Menu],
                    run: () => undefined,
                    children,
                })
            }
        }

        // Merge contributions (target: '…') into the matching top-level menu
        for (const contribution of contributions) {
            const target = topLevel.find(m => m.label === contribution.target)
            if (target) {
                target.children = [...target.children ?? [], ...contribution.items]
            }
        }

        // Sort children by declared weight (smaller first, default 0). The
        // stable sort keeps provider-declared order for unweighted items.
        for (const menu of topLevel) {
            menu.children = [...menu.children ?? []].sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0))
        }

        return topLevel
    }

    private itemToAction (item: AppMenuItem, id: string): Action {
        return {
            ...commonMenuItemParts(item),
            id,
            label: item.label,
            weight: item.weight,
            surfaces: [ActionSurface.Menu],
            type: item.checked !== undefined ? 'checkbox' : 'normal',
            separatorBefore: item.separatorBefore,
        }
    }
}

/**
 * Adapts legacy ToolbarButtonProvider onto the Action model. Weight mirrors the
 * historical mapping: <=0 → left toolbar, >0 → right toolbar (plus StartPage).
 */
@Injectable()
export class ToolbarActionAdapter extends ActionProvider {
    constructor (
        private config: ConfigService,
        @Inject(ToolbarButtonProvider) private providers: ToolbarButtonProvider[],
    ) {
        super()
    }

    provide (_ctx: ActionContext): Action[] {
        const actions: Action[] = []
        // Respect the plugin/provider blacklist (`enabledServices`), matching the
        // legacy toolbar & command-palette feeds.
        for (const provider of this.config.enabledServices(this.providers)) {
            let buttonIndex = 0
            for (const button of provider.provide()) {
                const surfaces: ActionSurface[] = []
                if ((button.weight ?? 0) <= 0) {
                    surfaces.push(ActionSurface.ToolbarLeft)
                } else {
                    surfaces.push(ActionSurface.ToolbarRight)
                }
                surfaces.push(ActionSurface.StartPage)
                actions.push({
                    // Positional id: two same-titled buttons from one provider
                    // must both survive the registry's id merge.
                    id: `toolbar:${provider.constructor.name}:${buttonIndex++}`,
                    label: button.title,
                    icon: button.icon,
                    weight: button.weight,
                    touchBarNSImage: button.touchBarNSImage,
                    touchBarTitle: button.touchBarTitle,
                    surfaces,
                    run: () => button.click?.(),
                })
            }
        }
        return actions
    }
}

function actionToMenuItem (action: Action, ctx: ActionContext): MenuItemOptions {
    if (action.type === 'separator') {
        return { type: 'separator' }
    }
    const hasChildren = !!(action.children && action.children.length > 0)
    return {
        id: action.id,
        // Parents with children become real submenu items. An explicit `normal`
        // type plus the no-op click below makes native menus (Windows/Linux)
        // drop the submenu arrow and swallow the click instead of opening the
        // submenu — pre-registry code passed `type: undefined` + `submenu`.
        type: hasChildren ? 'submenu' : action.type ?? 'normal',
        label: action.label,
        sublabel: action.sublabel,
        enabled: action.enabled ? action.enabled(ctx) : undefined,
        checked: action.checked ? action.checked(ctx) : undefined,
        submenu: hasChildren ? action.children!.map(c => actionToMenuItem(c, ctx)) : undefined,
        commandLabel: action.commandLabel,
        click: hasChildren ? undefined : () => action.run(ctx),
    }
}

/**
 * Inverse of the adapters: renders a registry [[Action]] list back into the
 * [[MenuItemOptions]] shape the host platform's context-menu API expects.
 * Consumers doing surface-specific post-processing (e.g. the pane-tab menu's
 * workspace-only filtering / Close-to-top) apply it after this conversion.
 */
export function actionsToMenuItems (actions: Action[], ctx: ActionContext): MenuItemOptions[] {
    return actions.map(action => actionToMenuItem(action, ctx))
}

/**
 * JSON-safe projection of a menu item for the dev parity self-check: all
 * presentation fields that differ between the legacy and the registry path,
 * with callbacks (click/run) intentionally excluded.
 */
function menuShapeOf (item: MenuItemOptions): any {
    return {
        // Normalize presentation fields so the legacy assembly (type: undefined,
        // no label) and the registry round-trip (type: 'normal', label: '') are
        // compared on equal footing — only real structural drift should warn.
        type: item.type ?? 'normal',
        label: item.label ?? '',
        sublabel: item.sublabel,
        commandLabel: item.commandLabel,
        enabled: item.enabled === undefined ? undefined : !!item.enabled,
        checked: item.checked === undefined ? undefined : !!item.checked,
        submenu: item.submenu ? item.submenu.map(menuShapeOf) : undefined,
    }
}

/**
 * Adapts the legacy TabContextMenuItemProvider contract onto the R3 Action
 * model so the tab-header and pane-tab context menus can render from the
 * unified registry while old providers keep working.
 *
 * The provider contributions are assembled exactly like the legacy pipelines
 * (`tabHeader.buildContextMenu` / `WorkspaceComponent.openPaneTabContextMenu`):
 * one separator between every adjacent provider section, leading separator
 * omitted. A per-item monotonic weight keeps that relative order through the
 * registry's global sort, and ids are unique so the registry never collapses
 * two providers' identical labels into one entry.
 */
@Injectable()
export class TabContextActionAdapter extends AsyncActionProvider {
    private sorted: TabContextMenuItemProvider[]

    constructor (
        @Optional() @Inject(TabContextMenuItemProvider) private providers: TabContextMenuItemProvider[],
    ) {
        super()
        this.sorted = [...this.providers].sort((a, b) => a.weight - b.weight)
    }

    /**
     * Tab-context actions are inherently async (per-tab provider calls), so the
     * synchronous registry path yields nothing for this surface. Sync surfaces
     * (menu bar / toolbar) never ask for `TabContext` anyway.
     */
    provide (_ctx: ActionContext): Action[] {
        return []
    }

    async provideAsync (ctx: ActionContext): Promise<Action[]> {
        if (!ctx.tab) {
            return []
        }
        const tabHeader = !!ctx.tabHeader
        const actions: Action[] = []
        let order = 0
        for (let pi = 0; pi < this.sorted.length; pi++) {
            if (pi > 0) {
                actions.push({ label: '', type: 'separator', surfaces: [ActionSurface.TabContext], weight: order++, run: () => undefined })
            }
            for (const item of await this.sorted[pi].getItems(ctx.tab, tabHeader)) {
                actions.push(this.itemToAction(item, `cxtm:${pi}:${order}`, order++))
            }
        }
        this.assertLegacyParity(ctx, actions, tabHeader)
        return actions
    }

    /**
     * Dev-only self-check (TABBY_DEV): replays the legacy per-provider assembly
     * (`[+sep, S0, +sep, S1, …].slice(1)`) and compares its structure against
     * what the registry path produces. Any drift between the two appears as a
     * console warning on every context-menu open, satisfying the roadmap's
     * new-vs-legacy menu comparison acceptance for the right-click surfaces.
     */
    private async assertLegacyParity (ctx: ActionContext, actions: Action[], tabHeader: boolean): Promise<void> {
        if (!(process as any)?.env?.TABBY_DEV) {
            return
        }
        let legacy: MenuItemOptions[] = []
        for (const provider of this.sorted) {
            legacy.push({ type: 'separator' })
            legacy = legacy.concat(await provider.getItems(ctx.tab!, tabHeader))
        }
        legacy = legacy.slice(1)

        const viaRegistry = actionsToMenuItems(actions, ctx).map(menuShapeOf)
        const viaLegacy = legacy.map(menuShapeOf)
        if (JSON.stringify(viaRegistry) !== JSON.stringify(viaLegacy)) {
            // eslint-disable-next-line no-console
            console.warn('[tabby-core] TabContext registry menu shape differs from the legacy assembly', {
                tabTitle: ctx.tab?.title,
                viaRegistry,
                viaLegacy,
            })
        }
    }

    private itemToAction (item: MenuItemOptions, id: string, weight: number): Action {
        return {
            ...commonMenuItemParts(item),
            // A provider-supplied stable id wins over the auto-generated one so
            // consumers can filter on semantics instead of labels.
            id: item.id ?? id,
            label: item.label ?? '',
            sublabel: item.sublabel,
            commandLabel: item.commandLabel,
            weight,
            surfaces: [ActionSurface.TabContext],
            type: item.type === 'checkbox' || item.type === 'radio' || item.type === 'separator'
                ? item.type
                : undefined,
            children: item.submenu ? item.submenu.map((c, i) => this.itemToAction(c, `${id}:${i}`, 0)) : undefined,
        }
    }
}

/**
 * Adapts the legacy CommandProvider contract onto the R3 Action model so the
 * fuzzy command palette can read from the unified registry while old providers
 * keep working. The provider blacklist (`enabledServices`) and the command
 * blacklist are enforced here, mirroring the legacy `CommandService` feed.
 */
@Injectable()
export class CommandActionAdapter extends AsyncActionProvider {
    constructor (
        private config: ConfigService,
        @Inject(CommandProvider) private providers: CommandProvider[],
    ) {
        super()
    }

    /**
     * Commands are produced by async providers, so the sync registry path
     * yields nothing for this surface.
     */
    provide (_ctx: ActionContext): Action[] {
        return []
    }

    async provideAsync (ctx: ActionContext): Promise<Action[]> {
        const commands: Command[] = []
        for (const provider of this.config.enabledServices(this.providers)) {
            commands.push(...await provider.provide({ tab: ctx.tab ?? undefined }))
        }
        return commands
            .filter(command => !this.config.store.commandBlacklist.includes(command.id))
            .map(command => {
                const surfaces: ActionSurface[] = [ActionSurface.Command]
                if (command.locations?.includes(CommandLocation.StartPage)) {
                    surfaces.push(ActionSurface.StartPage)
                }
                return {
                    id: command.id,
                    label: command.label,
                    sublabel: command.sublabel,
                    icon: command.icon,
                    weight: command.weight,
                    locations: command.locations,
                    surfaces,
                    run: () => command.run(),
                }
            })
    }
}
