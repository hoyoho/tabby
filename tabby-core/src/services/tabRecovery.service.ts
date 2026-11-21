import { Injectable, Inject } from '@angular/core'
import { TabRecoveryProvider, RecoveryToken } from '../api/tabRecovery'
import { BaseTabComponent, GetRecoveryTokenOptions } from '../components/baseTab.component'
import { Logger, LogService } from './log.service'
import { ConfigService } from './config.service'
import { NewTabParameters } from './tabs.service'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class TabRecoveryService {
    logger: Logger
    enabled = false

    private constructor (
        @Inject(TabRecoveryProvider) private tabRecoveryProviders: TabRecoveryProvider<BaseTabComponent>[]|null,
        private config: ConfigService,
        log: LogService,
    ) {
        this.logger = log.create('tabRecovery')
    }

    async saveTabs (tabs: BaseTabComponent[]): Promise<void> {
        const recoverWorkspaces = this.config.store.workspace?.recoverTabs
        if (!this.enabled || !recoverWorkspaces) {
            return
        }
        const tokens = await Promise.all(tabs.map(async tab => {
            try {
                return await this.getFullRecoveryToken(tab, { includeState: true, accurateWorkingDirectory: true })
            } catch (error) {
                this.logger.warn('Could not serialize tab for recovery:', tab, error)
                return null
            }
        }))
        try {
            window.localStorage.tabsRecovery = JSON.stringify(tokens.filter(token => !!token))
        } catch (error) {
            // Quota exceeded or storage disabled: recovery is best-effort and
            // must never take down the app.
            this.logger.warn('Could not persist tab recovery state:', error)
        }
    }

    async getFullRecoveryToken (tab: BaseTabComponent, options?: GetRecoveryTokenOptions): Promise<RecoveryToken|null> {
        const token = await tab.getRecoveryToken(options)
        if (token) {
            token.tabTitle = tab.title
            token.tabCustomTitle = tab.customTitle
            token.tabPinned = tab.pinned
            if (tab.icon) {
                token.tabIcon = tab.icon
            }
            token.disableDynamicTitle = tab.disableDynamicTitle
        }
        return token
    }

    async recoverTab (token: RecoveryToken): Promise<NewTabParameters<BaseTabComponent>|null> {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!token) {
            return null
        }
        for (const provider of this.config.enabledServices(this.tabRecoveryProviders ?? [])) {
            try {
                if (!await provider.applicableTo(token)) {
                    continue
                }
                const tab = await provider.recover(token)
                tab.inputs = tab.inputs ?? {}
                tab.inputs.icon = token.tabIcon ?? null
                tab.inputs.title = token.tabTitle || ''
                tab.inputs.customTitle = token.tabCustomTitle || ''
                tab.inputs.pinned = token.tabPinned ?? false
                tab.inputs.disableDynamicTitle = token.disableDynamicTitle
                return tab
            } catch (error) {
                this.logger.warn('Tab recovery crashed:', token, provider, error)
            }
        }
        return null
    }

    async recoverTabs (): Promise<NewTabParameters<BaseTabComponent>[]> {
        if (!window.localStorage.tabsRecovery) {
            return []
        }
        let tokens: RecoveryToken[] = []
        try {
            tokens = JSON.parse(window.localStorage.tabsRecovery)
            if (!Array.isArray(tokens)) {
                throw new Error('recovery state is not an array')
            }
        } catch (error) {
            this.logger.warn('Ignoring corrupt tab recovery state:', error)
            return []
        }
        const tabs: NewTabParameters<BaseTabComponent>[] = []
        for (const token of tokens) {
            const tab = await this.recoverTab(token)
            if (tab) {
                tabs.push(tab)
            }
        }
        return tabs
    }
}
