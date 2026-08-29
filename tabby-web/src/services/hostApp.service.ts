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

    windowDragStart (_kind: 'session'|'workspace', _token: any): void {
        // No cross-window drag in the web build
    }

    windowDragEnd (): void {
        // No cross-window drag in the web build
    }

    windowDragCancel (): void {
        // No cross-window drag in the web build
    }

    windowDragAccepted (): void {
        // No cross-window drag in the web build
    }

    windowDragCard (_card: { title: string, color?: string|null }): void {
        // No cross-window drag in the web build
    }

    relaunch (): void {
        location.reload()
    }

    quit (): void {
        window.close()
    }
}
