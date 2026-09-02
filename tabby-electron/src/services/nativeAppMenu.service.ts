import { Injectable } from '@angular/core'
import { ActionRegistry, ActionSurface, actionsToMenuItems, ConfigService, DockingService, HostAppService, Platform } from 'tabby-core'
import { ElectronService } from './electron.service'
import { ElectronHostWindow } from './hostWindow.service'

/**
 * macOS has no in-window hamburger menu — like VS Code, the menu lives in the
 * system menu bar at the top of the screen. This service mirrors the content
 * that the window hamburger shows (ActionSurface.Menu) onto the native macOS
 * application menu, so entries such as View ▸ Dock position work there too.
 *
 * macOS has a single application menu for the whole app, but which window the
 * action targets is per-window (dock position etc.). The menu therefore always
 * reflects the *focused* window and is rebuilt whenever the focused window or
 * its menu state changes.
 */
@Injectable({ providedIn: 'root' })
export class NativeAppMenuService {
    private constructor (
        private actions: ActionRegistry,
        private electron: ElectronService,
        private hostApp: HostAppService,
        private hostWindow: ElectronHostWindow,
        private config: ConfigService,
        docking: DockingService,
    ) {
        if (hostApp.platform !== Platform.macOS) {
            return
        }

        this.config.ready$.toPromise().then(() => this.update(true))
        this.config.changed$.subscribe(() => this.update())
        this.hostWindow.windowFocused$.subscribe(() => this.update())
        this.hostWindow.windowShown$.subscribe(() => this.update())
        docking.dockSide$.subscribe(() => this.update())
    }

    private update (force = false): void {
        if (this.hostApp.platform !== Platform.macOS) {
            return
        }
        if (!force && !this.hostWindow.getWindow().isFocused()) {
            return
        }
        const template: any[] = []
        template.push(this.applicationMenu())
        template.push(this.editMenu())
        for (const menu of this.actions.get(ActionSurface.Menu, {})) {
            if (!menu.children?.length) {
                continue
            }
            template.push({
                label: menu.label,
                submenu: actionsToMenuItems(menu.children, {}),
            })
        }
        template.push(this.windowMenu())
        this.electron.Menu.setApplicationMenu(this.electron.Menu.buildFromTemplate(template))
    }

    private applicationMenu (): any {
        return {
            label: 'Tabby',
            submenu: [
                { role: 'about', label: 'About Tabby' },
                { type: 'separator' },
                { label: 'Preferences', accelerator: 'Cmd+,', click: () => this.hostApp.openSettings() },
                { type: 'separator' },
                { role: 'services', submenu: [] },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        }
    }

    private editMenu (): any {
        return {
            role: 'editMenu',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'pasteAndMatchStyle' },
                { role: 'delete' },
                { role: 'selectAll' },
            ],
        }
    }

    private windowMenu (): any {
        return {
            role: 'windowMenu',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                { type: 'separator' },
                { role: 'front' },
            ],
        }
    }
}
