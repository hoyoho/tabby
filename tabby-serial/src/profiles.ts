import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import deepClone from 'clone-deep'
import { Injectable } from '@angular/core'
import { NewTabParameters, PartialProfile, SelectorService, HostAppService, Platform, TranslateService, QuickConnectProfileProvider } from 'tabby-core'
import { SerialProfileSettingsComponent } from './components/serialProfileSettings.component'
import { SerialTabComponent } from './components/serialTab.component'
import { BAUD_RATES, SerialProfile } from './api'

@Injectable({ providedIn: 'root' })
export class SerialProfilesService extends QuickConnectProfileProvider<SerialProfile> {
    id = 'serial'
    name = _('Serial')
    settingsComponent = SerialProfileSettingsComponent
    configDefaults = {
        options: {
            port: null,
            baudrate: null,
            databits: 8,
            stopbits: 1,
            parity: 'none',
            rtscts: false,
            xon: false,
            xoff: false,
            xany: false,
            inputMode: null,
            outputMode: null,
            inputNewlines: null,
            outputNewlines: null,
            scripts: [],
            slowSend: false,
            input: { backspace: 'backspace' },
        },
        clearServiceMessagesOnConnect: false,
    }

    constructor (
        private selector: SelectorService,
        private hostApp: HostAppService,
        private translate: TranslateService,
    ) {
        super()
    }

    async getBuiltinProfiles (): Promise<SerialProfile[]> {
        if (this.hostApp.platform === Platform.Web) {
            return [
                {
                    id: `serial:web`,
                    type: 'serial',
                    name: this.translate.instant('Serial connection'),
                    icon: 'fas fa-microchip',
                    isBuiltin: true,
                    isTemplate: true,
                } as SerialProfile,
            ]
        }

        // Only the template — physical ports are configured per-profile.
        return [
            {
                id: `serial:template`,
                type: 'serial',
                name: this.translate.instant('Serial connection'),
                icon: 'fas fa-microchip',
                isBuiltin: true,
                isTemplate: true,
            } as SerialProfile,
        ]
    }

    async getNewTabParameters (profile: SerialProfile): Promise<NewTabParameters<SerialTabComponent>> {
        if (!profile.options.baudrate) {
            profile = deepClone({ ...profile })
            profile.options.baudrate = await this.selector.show(
                this.translate.instant('Baud rate'),
                BAUD_RATES.map(x => ({
                    name: x.toString(), result: x, weight: x,
                })),
            )
        }
        return {
            type: SerialTabComponent,
            inputs: { profile },
        }
    }

    getSuggestedName (profile: SerialProfile): string {
        return this.getDescription(profile)
    }

    getDescription (profile: SerialProfile): string {
        return profile.options.port
    }

    quickConnect (query: string): PartialProfile<SerialProfile> {
        let port = query
        let baudrate = 115200
        if (query.includes('@')) {
            baudrate = parseInt(port.split('@')[1]) || baudrate
            port = port.split('@')[0]
        } else if (query.includes(':')) {
            baudrate = parseInt(port.split(':')[1]) || baudrate
            port = port.split(':')[0]
        }

        return {
            name: query,
            type: 'serial',
            options: {
                port,
                baudrate,
            },
        }
    }

    intoQuickConnectString (profile: SerialProfile): string|null {
        if (!profile.options.port) {
            return null
        }
        // baudrate defaults to null ("not chosen yet"), unlike ssh/telnet's real port
        // defaults - so null and 115200 both render bare, and both parse back to 115200
        const { port, baudrate } = profile.options
        return baudrate && baudrate !== 115200 ? `${port}@${baudrate}` : port
    }
}
