/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable, Inject } from '@angular/core'
import { AppService, MenuProvider, AppMenu } from 'tabby-core'
import { SettingsTabProvider } from './api'
import { SettingsTabComponent } from './components/settingsTab.component'

/** @hidden */
@Injectable()
export class SettingsMenuProvider extends MenuProvider {
    constructor (
        private app: AppService,
        @Inject(SettingsTabProvider) private settingsProviders: SettingsTabProvider[],
    ) {
        super()
    }

    getMenus (): AppMenu[] {
        const providers = [...this.settingsProviders].sort((a, b) => a.weight - b.weight)
        return [
            {
                label: 'Settings',
                weight: -100,
                items: [
                    {
                        label: 'Application',
                        click: () => this.openSettings('application'),
                    },
                    ...providers.map(p => ({
                        label: p.title,
                        click: () => this.openSettings(p.id),
                    })),
                ],
            },
        ]
    }

    private openSettings (activeTab: string): void {
        SettingsTabComponent.openSettingsTab(this.app, activeTab)
    }
}