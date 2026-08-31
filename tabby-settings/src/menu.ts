/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable, Inject, Injector } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import { AppService, MenuProvider, AppMenu } from 'tabby-core'
import { SettingsTabProvider } from './api'
import { SettingsTabComponent } from './components/settingsTab.component'

/** @hidden */
@Injectable()
export class SettingsMenuProvider extends MenuProvider {
    private translate: TranslateService|undefined

    constructor (
        private injector: Injector,
        private app: AppService,
        @Inject(SettingsTabProvider) private settingsProviders: SettingsTabProvider[],
    ) {
        super()
    }

    private t (str: string): string {
        try {
            this.translate ??= this.injector.get(TranslateService)
            return this.translate.instant(str)
        } catch {
            return str
        }
    }

    getMenus (): AppMenu[] {
        const providers = [...this.settingsProviders]
            .filter(p => p.section === 'top')
            .sort((a, b) => a.weight - b.weight)
        return [
            {
                name: 'Settings',
                label: this.t('Settings'),
                weight: -100,
                items: [
                    {
                        label: this.t('Application'),
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
