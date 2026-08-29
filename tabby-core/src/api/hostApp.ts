import { Observable, Subject } from 'rxjs'
import { Injector } from '@angular/core'
import { Logger, LogService } from '../services/log.service'
import { RecoveryToken } from './tabRecovery'

export enum Platform {
    Linux = 'Linux',
    macOS = 'macOS',
    Windows = 'Windows',
    Web = 'Web',
}

/**
 * Payload of a cross-window drag entering/committing this window.
 */
export interface WindowDragEvent {
    kind: 'workspace'|'session'
    token?: RecoveryToken
    x?: number
    y?: number
}

/**
 * Provides interaction with the main process
 */
export abstract class HostAppService {
    abstract get platform (): Platform
    abstract get configPlatform (): Platform

    protected settingsUIRequest = new Subject<void>()
    protected configChangeBroadcast = new Subject<void>()
    protected recoveryTokenOpen = new Subject<RecoveryToken>()
    protected logger: Logger

    protected windowDragEnter = new Subject<WindowDragEvent>()
    protected windowDragMove = new Subject<{ x: number, y: number }>()
    protected windowDragLeave = new Subject<void>()
    protected windowDragCommit = new Subject<{ kind: 'workspace'|'session', token: RecoveryToken }>()
    protected windowDragCommitted = new Subject<void>()
    protected windowDragCancelled = new Subject<void>()

    /**
     * Fired when a cross-window drag enters this window's area, with the
     * dragged tab's recovery token.
     */
    get windowDragEnter$ (): Observable<WindowDragEvent> { return this.windowDragEnter }

    /**
     * Fired repeatedly while a drag hovers this window.
     */
    get windowDragMove$ (): Observable<{ x: number, y: number }> { return this.windowDragMove }

    /**
     * Fired when a drag leaves this window's area.
     */
    get windowDragLeave$ (): Observable<void> { return this.windowDragLeave }

    /**
     * Fired when a drag is dropped onto this window — restore the token.
     */
    get windowDragCommit$ (): Observable<{ kind: 'workspace'|'session', token: RecoveryToken }> { return this.windowDragCommit }

    /**
     * Fired in the source window once the target window restored the dragged
     * tab — safe to drop the local copy now.
     */
    get windowDragCommitted$ (): Observable<void> { return this.windowDragCommitted }

    /**
     * Fired in the source window when the drag ended on nothing (drop outside
     * every window) — revert to the pre-drag state.
     */
    get windowDragCancelled$ (): Observable<void> { return this.windowDragCancelled }

    /**
     * Fired when Preferences is selected in the macOS menu
     */
    get settingsUIRequest$ (): Observable<void> { return this.settingsUIRequest }

    /**
     * Fired when another window modified the config file
     */
    get configChangeBroadcast$ (): Observable<void> { return this.configChangeBroadcast }

    /**
     * Fired when the host hands us a workspace recovery token — used to build
     * this window's content from a workspace dragged out of another window.
     */
    get openRecoveryToken$ (): Observable<RecoveryToken> { return this.recoveryTokenOpen }

    constructor (
        injector: Injector,
    ) {
        this.logger = injector.get(LogService).create('hostApp')
    }

    abstract newWindow (payload?: any): void

    /**
     * Starts a cross-window drag (source side): the main process will track
     * the cursor and route enter/move/leave/commit events to other windows.
     * @param kind  what is being dragged ('session' or 'workspace')
     * @param token  recovery token captured at drag start
     */
    abstract windowDragStart (kind: 'session'|'workspace', token: RecoveryToken): void

    /**
     * Source side: the pointer was released. The main process commits the
     * drag to the window currently under the cursor.
     */
    abstract windowDragEnd (): void

    /**
     * Source side: abort the drag (e.g. the pointer re-entered this window) —
     * drop the ghost and any pending state without committing.
     */
    abstract windowDragCancel (): void

    /**
     * Receiving side: the dragged tab was successfully restored.
     */
    abstract windowDragAccepted (): void

    /**
     * Source side: send the ghost-window drag card (title + color) shown while
     * the tab leaves the window, following the cursor.
     */
    abstract windowDragCard (card: { title: string, color?: string|null }): void

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    emitReady (): void { }

    abstract relaunch (): void

    abstract quit (): void
}
