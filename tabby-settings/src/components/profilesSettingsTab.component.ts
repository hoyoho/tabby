import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import deepClone from 'clone-deep'
import { Component, Inject, Type } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, HostAppService, Profile, SelectorService, ProfilesService, PlatformService, BaseComponent, PartialProfile, ProfileProvider, TranslateService, Platform, ProfileGroup, PartialProfileGroup, QuickConnectProfileProvider } from 'tabby-core'
import { EditProfileModalComponent } from './editProfileModal.component'
import { EditProfileGroupModalComponent, EditProfileGroupModalComponentResult } from './editProfileGroupModal.component'

_('Filter')
_('Ungrouped')

interface CollapsableProfileGroup extends ProfileGroup {
    collapsed: boolean
    children: PartialProfileGroup<CollapsableProfileGroup>[]
}

/** @hidden */
@Component({
    templateUrl: './profilesSettingsTab.component.pug',
    styleUrls: ['./profilesSettingsTab.component.scss'],
})
export class ProfilesSettingsTabComponent extends BaseComponent {
    templateProfiles: PartialProfile<Profile>[] = []
    profileGroups: PartialProfileGroup<CollapsableProfileGroup>[]
    rootGroups: PartialProfileGroup<CollapsableProfileGroup>[] = []

    filter = ''
    Platform = Platform
    shellSettingsComponent: Type<any>|null = null
    sshSettingsComponent: Type<any>|null = null
    private descriptionCache = new Map<string, string|null>()
    private draggedProfile: PartialProfile<Profile>|null = null

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
        @Inject(ProfileProvider) public profileProviders: ProfileProvider<Profile>[],
        private profilesService: ProfilesService,
        private selector: SelectorService,
        private ngbModal: NgbModal,
        private platform: PlatformService,
        private translate: TranslateService,
    ) {
        super()
        this.profileProviders.sort((a, b) => a.name.localeCompare(b.name))
    }

    async ngOnInit (): Promise<void> {
        const nodeRequire = (window as any).nodeRequire
        try {
            this.sshSettingsComponent = nodeRequire('tabby-ssh')?.SSHSettingsTabComponent ?? null
        } catch { /* optional dependency */ }
        if (this.hostApp.platform === Platform.Windows) {
            try {
                this.shellSettingsComponent = nodeRequire('tabby-local')?.ShellSettingsTabComponent ?? null
            } catch { /* optional dependency */ }
        }
        await this.refreshProfileGroups()
        await this.refreshProfiles()
        this.subscribeUntilDestroyed(this.config.changed$, () => this.refreshProfileGroups())
        this.subscribeUntilDestroyed(this.config.changed$, () => this.refreshProfiles())
    }

    async refreshProfiles (): Promise<void> {
        const allProfiles = await this.profilesService.getProfiles()
        // Built-in presets are never exposed as sessions: only user-defined
        // profiles (and templates used when creating) remain visible.
        this.templateProfiles = allProfiles.filter(x => x.isBuiltin && x.isTemplate)

        this.descriptionCache.clear()
        for (const p of allProfiles) {
            if (p.id) {
                this.descriptionCache.set(p.id, this.profilesService.getDescription(p))
            }
        }
    }

    launchProfile (profile: PartialProfile<Profile>): void {
        this.profilesService.openNewTabForProfile(profile)
    }

    async newProfile (base?: PartialProfile<Profile>): Promise<void> {
        if (!base) {
            let profiles = await this.profilesService.getProfiles()
            profiles = profiles.filter(x => !this.isProfileBlacklisted(x) && x.isTemplate)
            profiles.sort((a, b) => ProfilesService.templatePriority(a) - ProfilesService.templatePriority(b))
            base = await this.selector.show(
                this.translate.instant('Select a template'),
                profiles.map(p => ({
                    icon: p.icon ?? undefined,
                    description: this.profilesService.getDescription(p) ?? undefined,
                    name: p.name,
                    result: p,
                    weight: ProfilesService.templatePriority(p) * 10,
                })),
            ).catch(() => undefined)
            if (!base) {
                return
            }
        }
        const baseProfile: PartialProfile<Profile> = deepClone(base)
        delete baseProfile.id
        if (base.isTemplate) {
            baseProfile.name = ''
        } else if (!base.isBuiltin) {
            baseProfile.name = this.translate.instant('{name} copy', base)
        }
        baseProfile.isBuiltin = false
        baseProfile.isTemplate = false
        const result = await this.showProfileEditModal(baseProfile)
        if (!result) {
            return
        }
        if (!result.name) {
            const cfgProxy = this.profilesService.getConfigProxyForProfile(result)
            result.name = this.profilesService.providerForProfile(result)?.getSuggestedName(cfgProxy) ?? this.translate.instant('{name} copy', base)
        }
        await this.profilesService.newProfile(result)
        await this.config.save()
    }

    async editProfile (profile: PartialProfile<Profile>): Promise<void> {
        const result = await this.showProfileEditModal(profile)
        if (!result) {
            return
        }
        await this.profilesService.writeProfile(result)
        await this.config.save()
    }

    async showProfileEditModal (profile: PartialProfile<Profile>): Promise<PartialProfile<Profile>|null> {
        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )
        const provider = this.profilesService.providerForProfile(profile)
        if (!provider) {
            throw new Error('Cannot edit a profile without a provider')
        }
        modal.componentInstance.partialProfile = deepClone(profile)
        modal.componentInstance.profileProvider = provider

        const result = await modal.result.catch(() => null)
        if (!result) {
            return null
        }

        result.type = provider.id
        return result
    }

    async deleteProfile (profile: PartialProfile<Profile>): Promise<void> {
        if ((await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant('Delete "{name}"?', profile),
                buttons: [
                    this.translate.instant('Delete'),
                    this.translate.instant('Keep'),
                ],
                defaultId: 1,
                cancelId: 1,
            },
        )).response === 0) {
            await this.profilesService.deleteProfile(profile)
            await this.config.save()
        }
    }

    async newProfileGroup (): Promise<void> {
        this.editProfileGroup({
            id: 'new',
            name: '',
            icon: 'far fa-folder',
        })
    }

    async editProfileGroup (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        const result = await this.showProfileGroupEditModal(group)
        if (!result) {
            return
        }

        await this.profilesService.writeProfileGroup(ProfilesSettingsTabComponent.collapsableIntoPartialProfileGroup(result))
        await this.config.save()
    }

    async showProfileGroupEditModal (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<PartialProfileGroup<CollapsableProfileGroup>|null> {
        const modal = this.ngbModal.open(
            EditProfileGroupModalComponent,
            { size: 'lg' },
        )

        modal.componentInstance.group = deepClone(group)
        modal.componentInstance.providers = this.profileProviders

        const result: EditProfileGroupModalComponentResult<CollapsableProfileGroup> | null = await modal.result.catch(() => null)
        if (!result) {
            return null
        }

        if (result.provider) {
            return this.editProfileGroupDefaults(result.group, result.provider)
        }

        return result.group
    }

    private async editProfileGroupDefaults (group: PartialProfileGroup<CollapsableProfileGroup>, provider: ProfileProvider<Profile>): Promise<PartialProfileGroup<CollapsableProfileGroup>|null> {
        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )
        const model = group.defaults?.[provider.id] ?? {}
        model.type = provider.id
        modal.componentInstance.partialProfile = Object.assign({}, model)
        modal.componentInstance.profileProvider = provider
        modal.componentInstance.defaultsMode = 'group'

        const result = await modal.result.catch(() => null)
        if (result) {
            // Fully replace the config
            for (const k in model) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete model[k]
            }
            Object.assign(model, result)
            if (!group.defaults) {
                group.defaults = {}
            }
            group.defaults[provider.id] = model
        }
        return this.showProfileGroupEditModal(group)
    }

    async deleteProfileGroup (group: PartialProfileGroup<ProfileGroup>): Promise<void> {
        if ((await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant('Delete "{name}"?', group),
                buttons: [
                    this.translate.instant('Delete'),
                    this.translate.instant('Keep'),
                ],
                defaultId: 1,
                cancelId: 1,
            },
        )).response === 0) {
            let deleteProfiles = false
            if ((group.profiles?.length ?? 0) > 0 && (await this.platform.showMessageBox(
                {
                    type: 'warning',
                    message: this.translate.instant('Delete the group\'s profiles?'),
                    buttons: [
                        this.translate.instant('Move to "Ungrouped"'),
                        this.translate.instant('Delete'),
                    ],
                    defaultId: 0,
                    cancelId: 0,
                },
            )).response !== 0) {
                deleteProfiles = true
            }

            await this.profilesService.deleteProfileGroup(group, { deleteProfiles })
            await this.config.save()
        }
    }

    async refreshProfileGroups (): Promise<void> {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        const groups = await this.profilesService.getProfileGroups({ includeNonUserGroup: true, includeProfiles: true })
        // Drop the synthetic "Built-in" group (and its sub-groups); keep only
        // user groups and the un-grouped bucket.
        .then(gs => gs.filter(g => g.id === 'default' || g.editable !== false))
        groups.sort((a, b) => a.name.localeCompare(b.name))
        groups.sort((a, b) => (a.id === 'built-in' || !a.editable ? 1 : 0) - (b.id === 'built-in' || !b.editable ? 1 : 0))
        groups.sort((a, b) => (a.id === 'default' ? 0 : 1) - (b.id === 'default' ? 0 : 1))
        this.profileGroups = groups.map(g => ProfilesSettingsTabComponent.intoPartialCollapsableProfileGroup(g, profileGroupCollapsed[g.id] ?? false))
        this.rootGroups = this.profilesService.buildGroupTree(this.profileGroups)
    }

    isGroupVisible (group: PartialProfileGroup<ProfileGroup>): boolean {
        return !this.filter || (group.profiles ?? []).some(x => this.isProfileVisible(x))
    }

    blankContextMenu (event: MouseEvent): void {
        event.preventDefault()
        this.platform.popupContextMenu([
            {
                type: 'normal',
                label: this.translate.instant('New profile'),
                click: () => this.newProfile(),
            },
            {
                type: 'normal',
                label: this.translate.instant('New group'),
                click: () => this.newProfileGroup(),
            },
        ])
    }

    isProfileVisible (profile: PartialProfile<Profile>): boolean {
        return !this.filter || (profile.name + '$' + (this.getDescription(profile) ?? '')).toLowerCase().includes(this.filter.toLowerCase())
    }

    onProfileDragStart (profile: PartialProfile<Profile>, event: DragEvent): void {
        if (profile.isBuiltin) {
            return
        }
        this.draggedProfile = profile
        event.dataTransfer?.setData('text/plain', profile.id ?? '')
        event.dataTransfer!.effectAllowed = 'move'
    }

    allowDrop (event: DragEvent): void {
        event.preventDefault()
    }

    async onProfileDrop (event: DragEvent, group: PartialProfileGroup<ProfileGroup>): Promise<void> {
        event.preventDefault()
        this.allowDrop(event)
        const profile = this.draggedProfile
        this.draggedProfile = null
        if (!profile?.id || profile.isBuiltin) {
            return
        }
        await this.profilesService.setGroup(profile.id, group.id === 'default' ? '' : group.id)
        await this.refreshProfileGroups()
    }

    getDescription (profile: PartialProfile<Profile>): string|null {
        if (profile.id) {
            return this.descriptionCache.get(profile.id) ?? null
        }
        return this.profilesService.getDescription(profile)
    }

    getTypeLabel (profile: PartialProfile<Profile>): string {
        const name = this.profilesService.providerForProfile(profile)?.name
        if (name === 'Local terminal') {
            return ''
        }
        return name ? this.translate.instant(name) : this.translate.instant('Unknown')
    }

    getTypeColorClass (profile: PartialProfile<Profile>): string {
        return {
            ssh: 'secondary',
            serial: 'success',
            telnet: 'info',
            'split-layout': 'primary',
        }[this.profilesService.providerForProfile(profile)?.id ?? ''] ?? 'warning'
    }

    toggleGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        group.collapsed = !group.collapsed
        this.saveProfileGroupCollapse(group)
    }

    async editDefaults (provider: ProfileProvider<Profile>): Promise<void> {
        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )
        const model = this.profilesService.getProviderDefaults(provider)
        model.type = provider.id
        modal.componentInstance.partialProfile = Object.assign({}, model)
        modal.componentInstance.profileProvider = provider
        modal.componentInstance.defaultsMode = 'enabled'
        const result = await modal.result.catch(() => null)
        if (result) {
            // Fully replace the config
            for (const k in model) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete model[k]
            }
            Object.assign(model, result)
            this.profilesService.setProviderDefaults(provider, model)
            await this.config.save()
        }
    }

    async deleteDefaults (provider: ProfileProvider<Profile>): Promise<void> {
        if ((await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant('Restore settings to defaults ?'),
                buttons: [
                    this.translate.instant('Delete'),
                    this.translate.instant('Keep'),
                ],
                defaultId: 1,
                cancelId: 1,
            },
        )).response === 0) {
            this.profilesService.setProviderDefaults(provider, {})
            await this.config.save()
        }
    }

    blacklistProfile (profile: PartialProfile<Profile>): void {
        this.config.store.profileBlacklist = [...this.config.store.profileBlacklist, profile.id]
        this.config.save()
    }

    unblacklistProfile (profile: PartialProfile<Profile>): void {
        this.config.store.profileBlacklist = this.config.store.profileBlacklist.filter(x => x !== profile.id)
        this.config.save()
    }

    isProfileBlacklisted (profile: PartialProfile<Profile>): boolean {
        return profile.id && this.config.store.profileBlacklist.includes(profile.id)
    }

    getQuickConnectProviders (): ProfileProvider<Profile>[] {
        return this.profileProviders.filter(x => x instanceof QuickConnectProfileProvider)
    }

    /**
    * Save ProfileGroup collapse state in localStorage
    */
    private saveProfileGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        profileGroupCollapsed[group.id] = group.collapsed
        window.localStorage.profileGroupCollapsed = JSON.stringify(profileGroupCollapsed)
    }

    private static collapsableIntoPartialProfileGroup (group: PartialProfileGroup<CollapsableProfileGroup>): PartialProfileGroup<ProfileGroup> {
        const g: any = { ...group }
        delete g.collapsed
        delete g.children
        return g
    }

    private static intoPartialCollapsableProfileGroup (group: PartialProfileGroup<ProfileGroup>, collapsed: boolean): PartialProfileGroup<CollapsableProfileGroup> {
        const collapsableGroup = {
            ...group,
            collapsed,
        }
        return collapsableGroup
    }
}
