export interface MenuItemOptions {
    /** Stable identifier (non-translated) so consumers can filter/match items without coupling to label text. */
    id?: string
    type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
    label?: string
    sublabel?: string
    enabled?: boolean
    checked?: boolean
    submenu?: MenuItemOptions[]
    click?: () => void

    /** @hidden */
    commandLabel?: string
}
