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
    /** Gear icon shown in the tab header when tab profile icons are enabled. */
    static readonly tabIcon = 'fas fa-gear'

    @Input() activeTab: string
    Platform = Platform
    configDefaults: any
    configFile: string
    isShellIntegrationInstalled = false
    showConfigDefaults = false
    allLanguages = LocaleService.allLanguages
    testingProxy = false
    proxyTestOk = false
    proxyTestResult = ''
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
        private translate: TranslateService,
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

    /**
     * Probe the plugin registry from the main process through the same
     * proxy agent stack plugin installs use — this validates the actual
     * credentials instead of relying on Chromium's auth cache.
     */
    async testProxyConnection (): Promise<void> {
        this.testingProxy = true
        this.proxyTestResult = ''
        try {
            await this.config.save()
            const result = await this.platform.testProxyConnection()
            this.proxyTestOk = result.ok
            this.proxyTestResult = result.ok
                ? this.translate.instant(_('Network OK'))
                : result.error === 'EMPTY_PROXY'
                    ? this.translate.instant(_('Proxy server address is required'))
                    : this.translate.instant(_('Network failed'))
        } catch (err) {
            this.proxyTestOk = false
            this.proxyTestResult = this.translate.instant(_('Network failed'))
        } finally {
            this.testingProxy = false
        }
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
