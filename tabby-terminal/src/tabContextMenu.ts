import { Injectable, Optional, Inject } from '@angular/core'
import { BaseTabComponent, TabContextMenuItemProvider, NotificationsService, MenuItemOptions, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent } from './api/baseTerminalTab.component'
import { TerminalContextMenuItemProvider } from './api/contextMenuProvider'
import { ConnectableTerminalTabComponent } from './api/connectableTerminalTab.component'

/** @hidden */
@Injectable()
export class CopyPasteContextMenu extends TabContextMenuItemProvider {
    weight = -10

    constructor (
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) {
        super()
    }

    async getItems (tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]> {
        if (tabHeader) {
            return []
        }
        if (tab instanceof BaseTerminalTabComponent) {
            return [
                {
                    label: this.translate.instant('Copy'),
                    click: (): void => {
                        setTimeout(() => {
                            tab.frontend?.copySelection()
                            this.notifications.notice(this.translate.instant('Copied'))
                        })
                    },
                },
                {
                    label: this.translate.instant('Select all'),
                    click: (): void => {
                        setTimeout(() => {
                            tab.frontend?.selectAll()
                        })
                    },
                },
                {
                    label: this.translate.instant('Paste'),
                    click: () => tab.paste(),
                },
            ]
        }
        return []
    }
}

/** @hidden */
@Injectable()
export class MiscContextMenu extends TabContextMenuItemProvider {
    weight = 1

    constructor (
        private translate: TranslateService,
    ) { super() }

    async getItems (tab: BaseTabComponent): Promise<MenuItemOptions[]> {
        const items: MenuItemOptions[] = []
        if (tab instanceof BaseTerminalTabComponent && tab.session?.supportsWorkingDirectory()) {
            items.push({
                label: this.translate.instant('Copy current path'),
                click: () => tab.copyCurrentPath(),
            })
        }
        return items
    }
}

/** @hidden */
@Injectable()
export class ReconnectContextMenu extends TabContextMenuItemProvider {
    weight = 1

    constructor (
        private translate: TranslateService,
        private notifications: NotificationsService,
    ) { super() }

    async getItems (tab: BaseTabComponent): Promise<MenuItemOptions[]> {
        if (tab instanceof ConnectableTerminalTabComponent) {
            return [
                {
                    label: this.translate.instant('Disconnect'),
                    click: (): void => {
                        setTimeout(() => {
                            tab.disconnect()
                            this.notifications.notice(this.translate.instant('Disconnect'))
                        })
                    },
                },
                {
                    label: this.translate.instant('Reconnect'),
                    click: (): void => {
                        setTimeout(() => {
                            tab.reconnect()
                            this.notifications.notice(this.translate.instant('Reconnect'))
                        })
                    },
                },
            ]
        }
        return []
    }

}

/** @hidden */
@Injectable()
export class LegacyContextMenu extends TabContextMenuItemProvider {
    weight = 1

    constructor (
        @Optional() @Inject(TerminalContextMenuItemProvider) protected contextMenuProviders: TerminalContextMenuItemProvider[]|null,
    ) {
        super()
    }

    async getItems (tab: BaseTabComponent): Promise<MenuItemOptions[]> {
        if (!this.contextMenuProviders) {
            return []
        }
        if (tab instanceof BaseTerminalTabComponent) {
            let items: MenuItemOptions[] = []
            for (const p of this.contextMenuProviders) {
                items = items.concat(await p.getItems(tab))
            }
            return items
        }
        return []
    }

}

