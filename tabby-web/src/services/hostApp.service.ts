import Bowser from 'bowser'
import { Injectable, Injector } from '@angular/core'
import { HostAppService, Platform } from 'tabby-core'

@Injectable()
export class WebHostApp extends HostAppService {
    get platform (): Platform {
        return Platform.Web
    }

    get configPlatform (): Platform {
        const os = Bowser.parse(window.navigator.userAgent).os
        return Platform[os.name ?? 'Windows'] ?? Platform.Windows
    }

    // Needed for injector metadata
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        injector: Injector,
    ) {
        super(injector)
    }

    newWindow (_payload?: any): void {
        throw new Error('Not implemented')
    }

    nativeDragStart (_dragId: string, _savedState: any): void {
        // No cross-window drag in the web build
    }

    nativeDragEnd (_dragId: string): void {
        // No cross-window drag in the web build
    }

    nativeDragState (_dragId: string): any {
        // No cross-window drag in the web build
        return null
    }

    nativeDragStateUpdate (_dragId: string, _state: any): void {
        // No cross-window drag in the web build
    }

    nativeDragAccepted (_dragId: string): void {
        // No cross-window drag in the web build
    }

    getCursorScreenPoint (): { x: number, y: number }|null {
        // No main process to ask in the web build
        return null
    }

    relaunch (): void {
        location.reload()
    }

    quit (): void {
        window.close()
    }
}
