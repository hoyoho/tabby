import { Component, HostBinding, HostListener, Input, ChangeDetectorRef, Inject, Optional } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import deepClone from 'clone-deep'
import FuzzySearch from 'fuzzy-search'

import { ConfigService } from '../services/config.service'
import { ProfilesService } from '../services/profiles.service'
import { AppService } from '../services/app.service'
import { PlatformService } from '../api/platform'
import { ProfileProvider, SelectorService, ProfileEditHost } from '../api/index'
import { PartialProfileGroup, ProfileGroup, PartialProfile, Profile } from '../index'
import { BaseComponent } from './base.component'

interface CollapsableProfileGroup extends ProfileGroup {
    collapsed: boolean
    children: PartialProfileGroup<CollapsableProfileGroup>[]
}

/** @hidden */
@Component({
    selector: 'profile-tree',
    styleUrls: ['./profileTree.component.scss'],
    templateUrl: './profileTree.component.pug',
})
export class ProfileTreeComponent extends BaseComponent {
    profileGroups: PartialProfileGroup<ProfileGroup>[] = []
    rootGroups: PartialProfileGroup<ProfileGroup>[] = []

    filteredProfiles: PartialProfile<Profile>[] = []
    @Input() filter = ''
    private draggedProfile: PartialProfile<Profile>|null = null
    private draggedGroup: PartialProfileGroup<ProfileGroup>|null = null


    panelMinWidth = 200
    panelMaxWidth = 600
    // Below this released width the panel closes entirely; between here and
    // panelMinWidth it snaps back to panelMinWidth (avoids accidental close).
    panelCollapseThreshold = 30
    panelInternalWidth: number = parseInt(window.localStorage.profileTreeWidth ?? '300')
    panelStartWidth = this.panelInternalWidth
    panelIsResizing = false
    panelStartX = 0

    @HostBinding('class.resizing') get isResizing (): boolean {
        return this.panelIsResizing
    }

    constructor (
        private app: AppService,
        private platform: PlatformService,
        private config: ConfigService,
        private profilesService: ProfilesService,
        private translate: TranslateService,
        private selector: SelectorService,
        private cdr: ChangeDetectorRef,
        @Optional() @Inject(ProfileEditHost) private profileEditHost: ProfileEditHost|null,
    ) {
        super()
    }

    async ngOnInit (): Promise<void> {
        await this.loadTreeItems()
        this.subscribeUntilDestroyed(this.config.changed$, () => this.loadTreeItems())
        this.app.tabsChanged$.subscribe(() => this.tabStateChanged())
        this.app.activeTabChange$.subscribe(() => this.tabStateChanged())
    }


    private async loadTreeItems (): Promise<void> {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        let groups = await this.profilesService.getProfileGroups({ includeNonUserGroup: true, includeProfiles: true })

        for (const group of groups) {
            if (group.profiles?.length) {
                // remove template profiles
                group.profiles = group.profiles.filter(x => !x.isTemplate)

                // remove blocklisted profiles
                group.profiles = group.profiles.filter(x => x.id && !this.config.store.profileBlacklist.includes(x.id))
            }
        }

        // Built-in presets are never shown in the side panel: sessions are only
        // created from user profiles.
        groups = groups.filter(g => g.id === 'default' || g.editable !== false)

        groups.sort((a, b) => a.name.localeCompare(b.name))
        groups.sort((a, b) => (a.id === 'built-in' || !a.editable ? 1 : 0) - (b.id === 'built-in' || !b.editable ? 1 : 0))
        groups.sort((a, b) => (a.id === 'default' ? 0 : 1) - (b.id === 'default' ? 0 : 1))
        this.profileGroups = groups.map(g => ProfileTreeComponent.intoPartialCollapsableProfileGroup(g, profileGroupCollapsed[g.id] ?? false))
        this.rootGroups = this.profilesService.buildGroupTree(this.profileGroups)
        this.cdr.markForCheck()
    }

    private async editProfile (profile: PartialProfile<Profile>): Promise<void> {
        const provider = this.profilesService.providerForProfile(profile)
        if (!provider) { throw new Error('Cannot edit a profile without a provider') }

        const result = await this.profileEditHost?.editProfile({
            partialProfile: deepClone(profile),
            provider,
        }) ?? null
        if (!result) { return }

        result.type = provider.id

        await this.profilesService.writeProfile(result)
        await this.config.save()
    }

    private async editProfileGroup (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        const result = await this.profileEditHost?.editProfileGroup(
            deepClone(group),
            this.profilesService.getProviders(),
        ) ?? null
        if (!result) { return }

        if (result.provider) {
            return this.editProfileGroupDefaults(result.group, result.provider)
        }

        delete (result.group as any).collapsed
        delete (result.group as any).children
        await this.profilesService.writeProfileGroup(result.group)
        await this.config.save()
    }

    private async editProfileGroupDefaults (group: PartialProfileGroup<CollapsableProfileGroup>, provider: ProfileProvider<Profile>): Promise<void> {
        const model = group.defaults?.[provider.id] ?? {}
        model.type = provider.id

        const result = await this.profileEditHost?.editProfile({
            partialProfile: Object.assign({}, model),
            provider,
            defaultsMode: 'group',
        }) ?? null
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
        return this.editProfileGroup(group)
    }

    async profileContextMenu (profile: PartialProfile<Profile>, event: MouseEvent): Promise<void> {
        event.preventDefault()
        event.stopPropagation()

        this.platform.popupContextMenu([
            {
                type: 'normal',
                label: this.translate.instant('Run'),
                click: () => this.launchProfile(profile),
            },
            {
                type: 'normal',
                label: this.translate.instant('Edit'),
                click: () => this.editProfile(profile),
                enabled: !(profile.isBuiltin ?? profile.isTemplate),
            },
            {
                type: 'normal',
                label: this.translate.instant('Duplicate'),
                click: () => this.duplicateProfile(profile),
                enabled: !(profile.isBuiltin ?? profile.isTemplate),
            },
            {
                type: 'normal',
                label: this.translate.instant('Delete'),
                click: () => this.deleteProfile(profile),
                enabled: !(profile.isBuiltin ?? profile.isTemplate),
            },
        ])
    }

    async groupContextMenu (group: PartialProfileGroup<CollapsableProfileGroup>, event: MouseEvent): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        this.platform.popupContextMenu([
            {
                type: 'normal',
                label: group.collapsed ? this.translate.instant('Expand group') : this.translate.instant('Collapse group'),
                click: () => this.toggleGroupCollapse(group),
            },
            {
                type: 'normal',
                label: this.translate.instant('Edit group'),
                click: () => this.editProfileGroup(group),
                enabled: group.editable,
            },
        ])
    }

    async blankContextMenu (event: MouseEvent): Promise<void> {
        event.preventDefault()
        this.platform.popupContextMenu([
            {
                type: 'normal',
                label: this.translate.instant('New profile'),
                click: () => this.newProfileFromBlank(),
            },
            {
                type: 'normal',
                label: this.translate.instant('New group'),
                click: () => this.editProfileGroup({
                    id: 'new',
                    name: '',
                    icon: 'far fa-folder',
                }),
            },
        ])
    }

    async newProfileFromBlank (): Promise<void> {
        const templates = (await this.profilesService.getProfiles()).filter(x => x.isTemplate)
        templates.sort((a, b) => ProfilesService.templatePriority(a) - ProfilesService.templatePriority(b))
        const base = await this.selector.show(
            this.translate.instant('Select a template'),
            templates.map(p => ({
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
        const fresh: PartialProfile<Profile> = deepClone(base)
        delete (fresh as any).id
        fresh.name = ''
        fresh.isBuiltin = false
        fresh.isTemplate = false

        const provider = this.profilesService.providerForProfile(fresh)
        if (!provider) {
            return
        }
        const result = await this.profileEditHost?.editProfile({
            partialProfile: fresh,
            provider,
        }) ?? null
        if (!result) {
            return
        }
        result.type = provider.id
        await this.profilesService.newProfile(result)
        await this.config.save()
    }

    async duplicateProfile (profile: PartialProfile<Profile>): Promise<void> {
        const dup: PartialProfile<Profile> = deepClone(profile)
        delete (dup as any).id
        dup.name = this.translate.instant('{name} copy', { name: profile.name })
        dup.isBuiltin = false
        dup.isTemplate = false

        const provider = this.profilesService.providerForProfile(dup) ?? this.profilesService.providerForProfile(profile)
        if (!provider) {
            return
        }
        const result = await this.profileEditHost?.editProfile({
            partialProfile: dup,
            provider,
        }) ?? null
        if (!result) {
            return
        }
        result.type = provider.id
        await this.profilesService.newProfile(result)
        await this.config.save()
        await this.loadTreeItems()
    }

    async deleteProfile (profile: PartialProfile<Profile>): Promise<void> {
        if (profile.isBuiltin === true || profile.isTemplate === true) {
            return
        }
        if ((await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant('Delete "{name}"?', { name: profile.name }),
            buttons: [
                this.translate.instant('Delete'),
                this.translate.instant('Keep'),
            ],
            defaultId: 1,
            cancelId: 1,
        })).response === 0) {
            await this.profilesService.deleteProfile(profile)
            await this.config.save()
        }
    }

    private async tabStateChanged (): Promise<void> {
        // TODO: show active tab in the side panel with eye icon
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
        event.stopPropagation()
    }

    onGroupDragStart (group: PartialProfileGroup<ProfileGroup>, event: DragEvent): void {
        this.draggedGroup = group
        this.draggedProfile = null
        event.dataTransfer?.setData('text/plain', group.id)
        event.dataTransfer!.effectAllowed = 'move'
    }

    async onBlankDrop (event: DragEvent): Promise<void> {
        event.preventDefault()
        await this.moveToGroupId(null)
    }

    async onProfileDrop (event: DragEvent, group: PartialProfileGroup<ProfileGroup>): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        const targetId = group.id === 'default' ? '' : group.id
        await this.moveToGroupId(targetId)
    }

    private async moveToGroupId (groupId: string|null): Promise<void> {
        const profile = this.draggedProfile
        const group = this.draggedGroup
        this.draggedProfile = null
        this.draggedGroup = null
        if (profile && !profile.isBuiltin && profile.id) {
            await this.profilesService.setGroup(profile.id, groupId ?? '')
        } else if (group) {
            if (groupId && !this.profilesService.canGroupBeParentOf(groupId, group.id)) {
                await this.loadTreeItems()
                return
            }
            const cGroup = this.config.store.groups?.find(g => g.id === group.id)
            if (cGroup) {
                if (groupId) {
                    cGroup.parentGroupId = groupId
                } else {
                    delete cGroup.parentGroupId
                }
            }
            await this.config.save()
        }
        await this.loadTreeItems()
    }

    async launchProfile<P extends Profile> (profile: PartialProfile<P>): Promise<any> {
        return this.profilesService.launchProfile(profile)
    }

    async onFilterChange (): Promise<void> {
        try {
            const q = this.filter.trim().toLowerCase()

            if (q.length === 0) {
                this.rootGroups = this.profilesService.buildGroupTree(this.profileGroups)
                return
            }

            const profiles = await this.profilesService.getProfiles({
                includeBuiltin: false,
                clone: true,
            })

            const matches = new FuzzySearch(
                profiles.filter(p => !p.isTemplate),
                ['name', 'description'],
                { sort: false },
            ).search(q)

            this.rootGroups = [
                {
                    id: 'search',
                    editable: false,
                    name: this.translate.instant('Filter results'),
                    icon: 'fas fa-magnifying-glass',
                    profiles: matches,
                },
            ]
        } catch (error) {
            console.error('Error occurred during search:', error)
        }
    }

    ////// RESIZING //////
    startResize (event: MouseEvent): void {
        this.panelIsResizing = true
        this.panelStartX = event.clientX
        this.panelStartWidth = this.panelWidth
        event.preventDefault()
    }

    @HostListener('document:mousemove', ['$event'])
    onMouseMove (event: MouseEvent): void {
        if (!this.panelIsResizing) { return }
        const delta = event.clientX - this.panelStartX
        // The width tracks the mouse continuously (0..max); the close/min
        // decision is deferred to mouseup so the handle never teleports under
        // the cursor.
        const width = Math.max(0, Math.min(this.panelMaxWidth, this.panelStartWidth + delta))
        this.panelWidth = width
        this.cdr.markForCheck()
    }

    @HostListener('document:mouseup')
    stopResize (): boolean {
        this.panelIsResizing = false
        if (this.panelWidth < this.panelCollapseThreshold) {
            // Released near the left edge: close the panel entirely, it can
            // be re-enabled from the settings or the hotkey.
            this.config.store.showProfileTree = false
            this.config.save()
        } else {
            this.panelWidth = Math.min(this.panelMaxWidth, Math.max(this.panelMinWidth, this.panelWidth))
            window.localStorage.profileTreeWidth = this.panelWidth
        }
        this.cdr.markForCheck()
        return true
    }

    @HostBinding('style.width.px')
    get panelWidth (): number {
        return this.panelInternalWidth
    }

    set panelWidth (value: number) {
        this.panelInternalWidth = value
    }

    ////// GROUP COLLAPSING //////
    toggleGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        group.collapsed = !group.collapsed
        this.saveProfileGroupCollapse(group)
    }

    private saveProfileGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        profileGroupCollapsed[group.id] = group.collapsed
        window.localStorage.profileGroupCollapsed = JSON.stringify(profileGroupCollapsed)
    }

    private static intoPartialCollapsableProfileGroup (group: PartialProfileGroup<ProfileGroup>, collapsed: boolean): PartialProfileGroup<CollapsableProfileGroup> {
        const collapsableGroup = {
            ...group,
            collapsed,
        }
        return collapsableGroup
    }

}
