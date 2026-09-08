/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import * as yaml from 'js-yaml'
import { debounce } from 'utils-decorators/dist/esm/debounce/debounce'
import { Component, Inject, Input, HostBinding, Injector, ViewChild } from '@angular/core'
import { NgbNav } from '@ng-bootstrap/ng-bootstrap'
import {
    ConfigService,
    TopLevelTab,
    HostAppService,
    Platform,
    HomeBaseService,
    PlatformService,
    HostWindowService,
    AppService,
    LocaleService,
    TranslateService,
} from 'tabby-core'

import { SettingsTabProvider } from '../api'
import { ReleaseNotesComponent } from './releaseNotesTab.component'

/** @hidden */
@Component({
    selector: 'settings-tab',
    templateUrl: './settingsTab.component.pug',
    styleUrls: [
        './settingsTab.component.scss',
    ],
})
export class SettingsTabComponent extends TopLevelTab {
    /** Gear icon shown in the tab header when tab profile icons are enabled.
      * Inlined as SVG so `currentColor` follows the tab bar theme — an <img>
      * reference would render permanently black. */
    static readonly tabIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="currentColor" width="1em" height="1em" aria-hidden="true"><path d="M255.1 512c-56.05 0-75.99-11.33-75.99-35.94V436.5c-15.17-6.375-29.35-14.53-42.36-24.41l-34.3 19.78c-4.621 2.703-9.976 4.013-15.36 4.013c-36.71 0-76.25-92.87-76.25-108.6c0-10.85 5.806-21.34 15.71-27.07l34.17-19.72C60.52 272.1 59.99 264 59.99 255.1s.5313-16.13 1.625-24.47L27.42 211.8C17.53 206.1 11.73 195.6 11.73 184.7c0-12.58 37.98-108.7 76.2-108.7c5.417 0 10.82 1.338 15.52 4.111L137.6 99.88C150.6 90.01 164.8 81.85 179.1 75.47V35.91C179.1 4.335 215.7 0 256 0c39.71 0 75.1 4.083 75.1 35.91v39.56c15.17 6.375 29.35 14.53 42.36 24.41l34.3-19.78c4.621-2.703 9.981-4.013 15.37-4.013c36.47 0 76.24 92.55 76.24 108.6c0 10.85-5.806 21.34-15.71 27.07l-34.17 19.72c1.094 8.344 1.625 16.44 1.625 24.47s-.5313 16.13-1.625 24.47l34.19 19.75c9.895 5.703 15.7 16.19 15.7 27.05c0 12.59-37.98 108.7-76.21 108.7c-5.42 0-10.83-1.338-15.51-4.111l-34.19-19.72c-13.02 9.876-27.19 18.03-42.36 24.41v39.56C332 500.6 312.1 512 255.1 512zM140.9 373.2c35.92 30.82 52.34 34.36 71.05 41v61.85c14.11 2.344 28.82 3.727 43.76 3.727c14.95 0 30.13-1.383 45.19-4.571l-.9532-61c16.07-5.702 35.18-10.22 71.05-41l53.61 30.97c18.78-22.06 33.77-47.97 43.39-76.57l-52.94-30.56c2.745-14.99 4.859-25.43 4.859-39.07c0-10.95-1.364-23.97-4.859-43.06l53.46-30.85c-9.829-27.75-24.92-53.97-45.1-76.72l-52.43 31.41c-35.92-30.82-52.34-34.36-71.05-41V35.91c-14.11-2.344-28.82-3.727-43.76-3.727c-14.95 0-30.13 1.383-45.19 4.571l.9532 61C195.9 103.5 176.8 107.1 140.9 138.8L87.33 107.8c-18.99 22.31-34.08 48.53-43.69 77.47l53.24 29.66C94.14 229.9 92.02 240.4 92.02 253.1c0 10.95 1.364 23.97 4.859 43.06l-53.46 30.85c9.829 27.75 24.92 53.97 45.1 76.72L140.9 373.2zM256 351.1c-52.94 0-96-43.06-96-96S203.1 159.1 256 159.1s96 43.06 96 96S308.9 351.1 256 351.1zM256 191.1c-35.3 0-64 28.72-64 64S220.7 319.1 256 319.1s64-28.72 64-64S291.3 191.1 256 191.1z"/></svg>'

    @Input() activeTab: string
    Platform = Platform
    configDefaults: any
    configFile: string
    isShellIntegrationInstalled = false
    showConfigDefaults = false
    allLanguages = LocaleService.allLanguages
    @HostBinding('class.pad-window-controls') padWindowControls = false
    @ViewChild('nav', { static: true }) nav: NgbNav

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
        public hostWindow: HostWindowService,
        public homeBase: HomeBaseService,
        public platform: PlatformService,
        public locale: LocaleService,
        private app: AppService,
        @Inject(SettingsTabProvider) public settingsProviders: SettingsTabProvider[],
        translate: TranslateService,
        injector: Injector,
    ) {
        super(injector)
        // Set via the inherited accessor (TS2610: cannot shadow it with a field)
        this.icon = SettingsTabComponent.tabIcon
        this.setTitle(translate.instant(_('Settings')))
        this.settingsProviders = config.enabledServices(this.settingsProviders)
        this.settingsProviders = this.settingsProviders.filter(x => x.section === 'top' && !!x.getComponentType())
        this.settingsProviders.sort((a, b) => a.weight - b.weight + a.title.localeCompare(b.title))

        this.configDefaults = yaml.dump(config.getDefaults())

        const onConfigChange = () => {
            this.configFile = config.readRaw()
            this.padWindowControls = hostApp.platform === Platform.macOS
                && config.store.appearance.tabsLocation !== 'top'
        }

        this.subscribeUntilDestroyed(config.changed$, onConfigChange)
        onConfigChange()
    }

    async ngOnInit () {
        this.isShellIntegrationInstalled = await this.platform.isShellIntegrationInstalled()
    }

    /** Switch to a settings section on the existing instance. */
    showSection (id: string): void {
        this.activeTab = id
        this.nav.select(id)
    }

    /**
     * Opens the settings tab, reusing an existing one and navigating to
     * `activeTab` when possible.
     */
    static openSettingsTab (app: AppService, activeTab?: string): void {
        const existing = app.tabs.find(tab => tab instanceof SettingsTabComponent) as SettingsTabComponent|undefined
        if (existing) {
            existing.showSection(activeTab ?? 'application')
            app.selectTab(existing)
        } else {
            app.openNewTabRaw({
                type: SettingsTabComponent,
                inputs: { activeTab: activeTab ?? 'application' },
            })
        }
    }

    async toggleShellIntegration () {
        if (!this.isShellIntegrationInstalled) {
            await this.platform.installShellIntegration()
        } else {
            await this.platform.uninstallShellIntegration()
        }
        this.isShellIntegrationInstalled = await this.platform.isShellIntegrationInstalled()
    }

    ngOnDestroy () {
        this.config.save()
    }

    restartApp () {
        this.hostApp.relaunch()
    }

    @debounce(500)
    saveConfiguration (requireRestart?: boolean) {
        this.config.save()
        if (requireRestart) {
            this.config.requestRestart()
        }
    }

    saveConfigFile () {
        if (this.isConfigFileValid()) {
            this.config.writeRaw(this.configFile)
        }
    }

    showConfigFile () {
        this.platform.showItemInFolder(this.platform.getConfigPath()!)
    }

    isConfigFileValid () {
        try {
            yaml.load(this.configFile)
            return true
        } catch {
            return false
        }
    }

    showReleaseNotes () {
        this.app.openNewTabRaw({
            type: ReleaseNotesComponent,
        })
    }
}
