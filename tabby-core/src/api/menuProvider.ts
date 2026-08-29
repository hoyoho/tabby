export interface AppMenuItem {
    label: string
    click: () => void
    enabled?: boolean
    separatorBefore?: boolean
    checked?: boolean
    /** 菜单内排序权重（小在前），默认 0 */
    weight?: number
}

export interface AppMenu {
    /** 显示给用户的文字（可翻译） */
    label: string
    items: AppMenuItem[]
    /**
     * 菜单的英文标识符（不翻译），供 `target` 匹配使用。
     * 若未指定则 fallback 到原始 label。
     */
    name?: string
    /**
     * 排序权重。所有菜单按 (provider.weight + menu.weight) 升序排列。
     * 约定：
     *   Settings/File  ~ -100
     *   Edit           ~ 20
     *   View           ~ 40
     *   Session/Tools  ~ 60
     *   Window         ~ 80
     *   Help           ~ 1000（恒在最后）
     */
    weight?: number
    /**
     * 若指定，则不是新建顶级菜单，而是把 items 追加到 name/label 同名菜单里
     * （供插件往已有菜单补充选项）
     */
    target?: string
}

/**
 * Extend to contribute top-level menus to the title-bar hamburger menu
 */
export abstract class MenuProvider {
    weight = 0
    abstract getMenus (): AppMenu[]
}