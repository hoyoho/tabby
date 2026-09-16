/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Observable, OperatorFunction, debounceTime, map, distinctUntilChanged } from 'rxjs'
import { Component, Input, ViewChild, ViewContainerRef, ComponentFactoryResolver, Injector } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { PartialProfileGroup, Profile, ProfileProvider, ProfileSettingsComponent, ProfilesService, TAB_COLORS, ProfileGroup, ConnectableProfileProvider, FullyDefined, ConfigProxy } from 'tabby-core'

const iconsData = require('../../../tabby-core/src/icons.json')
const iconsClassList = Object.keys(iconsData).map(
    icon => iconsData[icon].map(
        style => `fa${style[0]} fa-${icon}`,
    ),
).flat()

/** @hidden */
@Component({
    templateUrl: './editProfileModal.component.pug',
})
export class EditProfileModalComponent<P extends Profile, PP extends ProfileProvider<P>> {
    @Input('profile') partialProfile: P
    @Input() profileProvider: PP
    @Input() settingsComponent: new () => ProfileSettingsComponent<P, PP>
    @Input() defaultsMode: 'enabled'|'group'|'disabled' = 'disabled'
    @Input() profileGroup: PartialProfileGroup<ProfileGroup> | undefined
    groups: (PartialProfileGroup<ProfileGroup> & { displayName: string })[]
    @ViewChild('placeholder', { read: ViewContainerRef }) placeholder: ViewContainerRef

    protected profile: FullyDefined<P> & ConfigProxy<FullyDefined<P>>
    private settingsComponentInstance?: ProfileSettingsComponent<P, PP>

    constructor (
        private injector: Injector,
        private componentFactoryResolver: ComponentFactoryResolver,
        private profilesService: ProfilesService,
        private modalInstance: NgbActiveModal,
    ) {
        if (this.defaultsMode === 'disabled') {
            this.profilesService.getProfileGroupsFlattened().then(groups => {
                this.groups = groups
                this.profileGroup = groups.find(g => g.id === this.partialProfile.group)
            })
        }
    }

    colorsAutocomplete = text$ => text$.pipe(
        debounceTime(200),
        distinctUntilChanged(),
        map((q: string) =>
            TAB_COLORS
                .filter(x => !q || x.name.toLowerCase().startsWith(q.toLowerCase()))
                .map(x => x.value),
        ),
    )

    colorsFormatter = value => {
        return TAB_COLORS.find(x => x.value === value)?.name ?? value
    }

    /**
     * `<input type='color'>` only accepts strict `#rrggbb`: binding the raw
     * `profile.color` (null until a color is picked, or a free-form string
     * typed by hand in the sibling text input) makes Angular write an invalid
     * value into it, and Chromium logs a console warning on every modal open.
     * Feed the picker a neutral fallback unless the value is well-formed hex —
     * the text input stays free-form so CSS consumers can still use names —
     * and only write through when the user actually picks a color.
     */
    get colorPickerValue (): string {
        const color = this.profile?.color
        return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#000000'
    }
    set colorPickerValue (color: string) {
        this.profile.color = color
    }

    ngOnInit () {
        this.profile = this.profilesService.getConfigProxyForProfile<P>(this.partialProfile, { skipGlobalDefaults: this.defaultsMode === 'enabled', skipGroupDefaults: this.defaultsMode === 'group' })
    }

    ngAfterViewInit () {
        const componentType = this.profileProvider.settingsComponent
        if (componentType) {
            setTimeout(() => {
                const componentFactory = this.componentFactoryResolver.resolveComponentFactory(componentType)
                const componentRef = componentFactory.create(this.injector)
                this.settingsComponentInstance = componentRef.instance
                this.settingsComponentInstance.profile = this.profile
                this.placeholder.insert(componentRef.hostView)
            })
        }
    }

    groupTypeahead: OperatorFunction<string, readonly (PartialProfileGroup<ProfileGroup> & { displayName: string })[]> = (text$: Observable<string>) =>
        text$.pipe(
            debounceTime(200),
            distinctUntilChanged(),
            map(q => this.groups.filter(g => !q || (g.displayName ?? g.name).toLowerCase().includes(q.toLowerCase()))),
        )

    groupFormatter = (g: PartialProfileGroup<ProfileGroup>) => (g as any).displayName ?? g.name

    iconSearch: OperatorFunction<string, string[]> = (text$: Observable<string>) =>
        text$.pipe(
            debounceTime(200),
            map(term => iconsClassList.filter(v => v.toLowerCase().includes(term.toLowerCase()))),
        )

    save () {
        if (!this.profileGroup) {
            this.profile.group = ''
        } else {
            this.profile.group = this.profileGroup.id
        }

        this.settingsComponentInstance?.save?.()
        this.profile.__cleanup()
        this.modalInstance.close(this.partialProfile)
    }

    cancel () {
        this.modalInstance.dismiss()
    }

    isConnectable (): boolean {
        return this.profileProvider instanceof ConnectableProfileProvider
    }

}
