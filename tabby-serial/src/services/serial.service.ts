import { Injectable } from '@angular/core'
import { ipcRenderer } from 'electron'
import WSABinding from 'serialport-binding-webserialapi'
import { HostAppService, Platform } from 'tabby-core'
import { SerialPortInfo } from '../api'

@Injectable({ providedIn: 'root' })
export class SerialService {
    private constructor (
        private hostApp: HostAppService,
    ) { }

    async listPorts (): Promise<SerialPortInfo[]> {
        try {
            if (this.hostApp.platform === Platform.Web) {
                return (await WSABinding.list()).map(x => ({
                    name: x.path,
                    description: `${x.manufacturer ?? ''} ${x.serialNumber ?? ''}`.trim() || undefined,
                }))
            }
            // Native bindings load in the main process (app/lib/serial.ts).
            return await ipcRenderer.invoke('serial:list-ports')
        } catch (err) {
            console.error('Failed to list serial ports', err)
            return []
        }
    }
}
