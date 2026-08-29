import { BaseTabComponent } from '../components/baseTab.component'
import { SessionTab } from './session'
import { CommandLocation } from './commands'

/**
 * UI surface an action can appear on. One Action definition can target
 * multiple surfaces so a single plugin declaration shows up everywhere.
 */
export enum ActionSurface {
    Menu = 'menu',
    ToolbarLeft = 'toolbar-left',
    ToolbarRight = 'toolbar-right',
    TabContext = 'tab-context',
    StartPage = 'start-page',
    /**
     * Fuzzy-search command palette (the "Commands" selector). Any action
     * targeting this surface becomes an entry there.
     */
    Command = 'command',
}

export interface ActionContext {
    /** Active top-level tab (workspace / settings / welcome …) */
    tab?: BaseTabComponent|null
    /** Focused session, when the context is a session/tab context menu */
    session?: SessionTab|null
    /** True when the query comes from a tab header context menu */
    tabHeader?: boolean
}

export interface Action {
    id?: string
    /** Translate key or already-translated label */
    label: string
    sublabel?: string
    /** Raw SVG icon code (toolbar / selector) */
    icon?: string
    weight?: number
    surfaces: ActionSurface[]
    run: (ctx: ActionContext) => void|Promise<void>
    enabled?: (ctx: ActionContext) => boolean
    /**
     * Menu presentation
     */
    type?: 'normal'|'checkbox'|'radio'|'separator'
    checked?: (ctx: ActionContext) => boolean
    separatorBefore?: boolean
    /** Nested actions (top-level menus, submenus) */
    children?: Action[]
    /**
     * Alternate label used by command consumers (the command palette flattens
     * submenus / strips workspace-level wording via this key).
     */
    commandLabel?: string
    /**
     * Legacy command placement hints (start page / toolbars), preserved for
     * adapters that bridge the CommandProvider contract.
     */
    locations?: CommandLocation[]
    /**
     * Touch Bar info
     */
    touchBarNSImage?: string
    touchBarTitle?: string
}

/**
 * Extend to contribute actions; the registry fans them out to the surfaces
 * the action declares. This is the single write-path (R3); the legacy
 * MenuProvider / ToolbarButtonProvider / TabContextMenuItemProvider /
 * CommandProvider are adapted onto it.
 */
export abstract class ActionProvider {
    abstract provide (ctx: ActionContext): Action[]
}

/**
 * Optional async variant for providers whose actions depend on awaited
 * context (e.g. tab context menus). Registry.getAsync prefers this.
 */
export abstract class AsyncActionProvider extends ActionProvider {
    abstract provideAsync (ctx: ActionContext): Promise<Action[]>
}
