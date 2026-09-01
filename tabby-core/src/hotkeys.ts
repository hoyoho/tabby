import { Injectable } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import { HotkeyDescription, HotkeyProvider } from './api/hotkeyProvider'

/** @hidden */
@Injectable()
export class AppHotkeyProvider extends HotkeyProvider {
    hotkeys: HotkeyDescription[] = [
        {
            id: 'command-selector',
            name: this.translate.instant('Show command selector'),
        },
        {
            id: 'profile-selector',
            name: this.translate.instant('Show profile selector'),
        },
        {
            id: 'toggle-fullscreen',
            name: this.translate.instant('Toggle fullscreen mode'),
        },
        {
            id: 'toggle-profile-tree',
            name: this.translate.instant('Show or hide the profile sidebar'),
        },
        {
            id: 'rename-tab',
            name: this.translate.instant('Rename workspace'),
        },
        {
            id: 'close-tab',
            name: this.translate.instant('Close workspace'),
        },
        {
            id: 'reopen-tab',
            name: this.translate.instant('Reopen last workspace'),
        },
        {
            id: 'toggle-last-tab',
            name: this.translate.instant('Toggle last workspace'),
        },
        {
            id: 'next-tab',
            name: this.translate.instant('Next workspace'),
        },
        {
            id: 'previous-tab',
            name: this.translate.instant('Previous workspace'),
        },
        {
            id: 'move-tab-left',
            name: this.translate.instant('Move workspace to the left'),
        },
        {
            id: 'move-tab-right',
            name: this.translate.instant('Move workspace to the right'),
        },
        {
            id: 'duplicate-tab',
            name: this.translate.instant('Duplicate workspace'),
        },
        {
            id: 'pin-tab',
            name: this.translate.instant('Pin or unpin workspace'),
        },
        {
            id: 'restart-tab',
            name: this.translate.instant('Restart workspace'),
        },
        {
            id: 'explode-tab',
            name: this.translate.instant('Split current workspace into separate workspaces'),
        },
        {
            id: 'combine-tabs',
            name: this.translate.instant('Combine all workspaces into one workspace'),
        },
        {
            id: 'split-right',
            name: this.translate.instant('Split to the right'),
        },
        {
            id: 'split-bottom',
            name: this.translate.instant('Split to the bottom'),
        },
        {
            id: 'split-left',
            name: this.translate.instant('Split to the left'),
        },
        {
            id: 'split-top',
            name: this.translate.instant('Split to the top'),
        },
        {
            id: 'pane-nav-up',
            name: this.translate.instant('Focus the pane above'),
        },
        {
            id: 'pane-nav-down',
            name: this.translate.instant('Focus the pane below'),
        },
        {
            id: 'pane-nav-left',
            name: this.translate.instant('Focus the pane on the left'),
        },
        {
            id: 'pane-nav-right',
            name: this.translate.instant('Focus the pane on the right'),
        },
        {
            id: 'session-nav-previous',
            name: this.translate.instant('Focus previous session'),
        },
        {
            id: 'session-nav-next',
            name: this.translate.instant('Focus next session'),
        },
        {
            id: 'switch-profile',
            name: this.translate.instant('Switch profile in the active pane'),
        },
        {
            id: 'close-session',
            name: this.translate.instant('Close focused session'),
        },
        {
            id: 'splitter-top-up',
            name: this.translate.instant('Move upper splitter up'),
        },
        {
            id: 'splitter-top-down',
            name: this.translate.instant('Move upper splitter down'),
        },
        {
            id: 'splitter-bottom-up',
            name: this.translate.instant('Move lower splitter up'),
        },
        {
            id: 'splitter-bottom-down',
            name: this.translate.instant('Move lower splitter down'),
        },
        {
            id: 'splitter-left-left',
            name: this.translate.instant('Move left splitter left'),
        },
        {
            id: 'splitter-left-right',
            name: this.translate.instant('Move left splitter right'),
        },
        {
            id: 'splitter-right-left',
            name: this.translate.instant('Move right splitter left'),
        },
        {
            id: 'splitter-right-right',
            name: this.translate.instant('Move right splitter right'),
        },
    ]

    constructor (
        private translate: TranslateService,
    ) { super() }

    async provide (): Promise<HotkeyDescription[]> {
        return [
            ...this.hotkeys.map(item => ({
                ...item,
                name: this.relocalize(item.name),
            })),
            ...Array.from({ length: 20 }, (_, i) => ({
                id: `tab-${i + 1}`,
                name: this.translate.instant('Workspace {number}', { number: i + 1 }),
            })),
            ...Array.from({ length: 9 }, (_, i) => ({
                id: `pane-nav-${i + 1}`,
                name: this.translate.instant('Focus pane {number}', { number: i + 1 }),
            })),
        ]
    }

    private relocalize (name: string): string {
        if (/^[A-Za-z][^]*$/.test(name)) {
            const translated = this.translate.instant(name)
            return translated && translated !== name ? translated : name
        }
        return name
    }

}
