import { Inject, Injectable, Optional, Injector } from '@angular/core'
import { AppService, Command, CommandContext, ConfigService, MenuItemOptions, WorkspaceComponent, ToolbarButton, ToolbarButtonProvider, TranslateService, BaseTabComponent } from '../api'
import { SelectorService } from './selector.service'
import { Action, ActionContext, ActionSurface } from '../api/action'
import { actionsToMenuItems } from '../api/adapters'
import { ActionRegistry } from './action.service'

@Injectable({ providedIn: 'root' })
export class CommandService {
    private lastCommand = Promise.resolve()

    constructor (
        private selector: SelectorService,
        private config: ConfigService,
        private app: AppService,
        private translate: TranslateService,
        private injector: Injector,
        @Optional() @Inject(ToolbarButtonProvider) private toolbarButtonProviders: ToolbarButtonProvider[],
    ) { }

    /**
     * Resolved lazily: ActionRegistry pulls in every ActionProvider (incl. the
     * MenuActionAdapter → AppMenuProvider chain, whose constructor requests this
     * very service for "Commands"). Eventual injection would form a DI cycle
     * (NG0200); by the time `getCommands` runs this service is already hydrated,
     * so the provider chain finds the existing instance and the cycle dissolves.
     */
    private get actions (): ActionRegistry {
        return this.injector.get(ActionRegistry)
    }

    private async contextMenuSections (tab: BaseTabComponent, tabHeader: boolean): Promise<MenuItemOptions[][]> {
        // The TabContext adapter emits one separator between adjacent provider
        // sections — split on them to recover the per-provider sections the
        // palette historically deduplicated against.
        const actions = await this.actions.getAsync(ActionSurface.TabContext, { tab, tabHeader })
        const sections: MenuItemOptions[][] = []
        let current: MenuItemOptions[] = []
        for (const action of actions) {
            if (action.type === 'separator') {
                sections.push(current)
                current = []
            } else {
                current.push(actionsToMenuItems([action], { tab })[0])
            }
        }
        sections.push(current)
        return sections
    }

    private commandFromAction (action: Action, ctx: ActionContext): Command {
        const command = new Command()
        command.id = action.id
        command.label = action.label
        command.sublabel = action.sublabel
        command.icon = action.icon
        command.weight = action.weight
        command.locations = action.locations
        command.run = async () => { await action.run(ctx) }
        return command
    }

    async getCommands (context: CommandContext): Promise<Command[]> {
        const ctx: ActionContext = { tab: context.tab ?? null }

        let buttons: ToolbarButton[] = []
        this.config.enabledServices(this.toolbarButtonProviders).forEach(provider => {
            buttons = buttons.concat(provider.provide())
        })
        buttons = buttons
            .sort((a: ToolbarButton, b: ToolbarButton) => (a.weight ?? 0) - (b.weight ?? 0))

        let items: MenuItemOptions[] = []
        if (context.tab) {
            for (const tabHeader of [false, true]) {
                for (const section of await this.contextMenuSections(context.tab, tabHeader)) {
                    // eslint-disable-next-line @typescript-eslint/no-loop-func
                    items = items.concat(section.filter(item => !items.some(ex => ex.label === item.label)))
                }
                if (context.tab instanceof WorkspaceComponent) {
                    const tab = context.tab.getFocusedTab()
                    if (tab) {
                        for (const section of await this.contextMenuSections(tab, tabHeader)) {
                            // eslint-disable-next-line @typescript-eslint/no-loop-func
                            items = items.concat(section.filter(item => !items.some(ex => ex.label === item.label)))
                        }
                    }
                }
            }
        }

        items = items.filter(x => (x.enabled ?? true) && x.type !== 'separator')

        const flatItems: MenuItemOptions[] = []
        function flattenItem (item: MenuItemOptions, prefix?: string): void {
            if (item.submenu) {
                item.submenu.forEach(x => flattenItem(x, (prefix ? `${prefix} > ` : '') + (item.commandLabel ?? item.label)))
            } else {
                flatItems.push({
                    ...item,
                    label: (prefix ? `${prefix} > ` : '') + (item.commandLabel ?? item.label),
                })
            }
        }
        items.forEach(x => flattenItem(x))

        const commands = buttons.map(x => Command.fromToolbarButton(x))
        commands.push(...flatItems.map(x => Command.fromMenuItem(x)))

        // Command providers feed the same registry both surfaces see.
        for (const action of await this.actions.getAsync(ActionSurface.Command, ctx)) {
            commands.push(this.commandFromAction(action, ctx))
        }

        return commands
            .filter(c => !this.config.store.commandBlacklist.includes(c.id))
            .sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0))
            .map(command => {
                const run = command.run
                command.run = async () => {
                    // Serialize execution
                    this.lastCommand = this.lastCommand.finally(run)
                    await this.lastCommand
                }
                return command
            })
    }

    async run (id: string, context: CommandContext): Promise<void> {
        const commands = await this.getCommands(context)
        const command = commands.find(x => x.id === id)
        await command?.run()
    }

    async showSelector (): Promise<void> {
        if (this.selector.active) {
            return
        }

        const context: CommandContext = {}
        const tab = this.app.activeTab
        if (tab instanceof WorkspaceComponent) {
            // Hand the workspace to getCommands: it contributes the
            // workspace-level items AND (inside getCommands) the focused
            // session's items, so the palette keeps "Close other workspaces",
            // "Save layout as profile", Rename/Color etc. reachable.
            context.tab = tab
        }
        const commands = await this.getCommands(context)
        return this.selector.show(
            this.translate.instant('Commands'),
            commands.map(c => ({
                name: c.label,
                callback: c.run,
                description: c.sublabel,
                icon: c.icon,
            })),
        )
    }
}
