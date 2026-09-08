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
 * Provides interaction with the main process
 */
export abstract class HostAppService {
    abstract get platform (): Platform
    abstract get configPlatform (): Platform

    protected settingsUIRequest = new Subject<void>()
    protected configChangeBroadcast = new Subject<void>()
    protected recoveryTokenOpen = new Subject<RecoveryToken>()
    protected logger: Logger

    protected nativeDragCommitted = new Subject<string>()

    /**
     * Fired in the source window of a native (HTML5/system DnD) session drag
     * once the receiving window successfully restored the dragged session (its
     * `nativeDragAccepted` round-tripped through the main process). Carries the
     * drag id; the source drops its local copy on receipt.
     */
    get nativeDragCommitted$ (): Observable<string> { return this.nativeDragCommitted }

    /**
     * Fired when Preferences is selected in the macOS menu
     */
    get settingsUIRequest$ (): Observable<void> { return this.settingsUIRequest }

    /**
     * Opens this window's Settings UI (used by the macOS application menu's
     * Preferences item).
     */
    openSettings (): void {
        this.settingsUIRequest.next()
    }

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
     * Source side: register a native (HTML5/system DnD) session drag with the
     * main process so a drop in another window can resolve back to this one.
     * @param dragId  opaque id set into the drag payload at dragstart
     * @param savedState  serialized screen state, kept OUT of the DataTransfer
     *                    payload (custom-DnD blobs are sized/raced by the
     *                    compositor) and fetched by the drop target by id
     */
    abstract nativeDragStart (dragId: string, savedState: any): void

    /**
     * Source side: the native drag is over without a committed cross-window
     * drop (cancelled, or settled locally) — release the registration.
     */
    abstract nativeDragEnd (dragId: string): void

    /**
     * Receiving side: fetch the dragged session's serialized screen state that
     * the source registered with [[nativeDragStart]]. Returns null when the
     * source already released the drag (cross-window restore is degraded to a
     * fresh screen then, never a broken session).
     */
    abstract nativeDragState (dragId: string): any

    /**
     * Source side: update the state registered with [[nativeDragStart]] — used
     * by workspace drags, whose recovery token serializes asynchronously after
     * the drag has started.
     */
    abstract nativeDragStateUpdate (dragId: string, state: any): void

    /**
     * Receiving side: the dragged session was successfully restored — tell the
     * main process to notify the source window (`nativeDragCommitted$`).
     */
    abstract nativeDragAccepted (dragId: string): void

    /**
     * Current cursor position in screen coordinates (DIP), sampled when
     * called. Used to place a detached workspace's new window at the release
     * point; null when the host cannot report it (web build — the caller
     * keeps the workspace in place instead).
     */
    abstract getCursorScreenPoint (): { x: number, y: number }|null

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    emitReady (): void { }

    abstract relaunch (): void

    abstract quit (): void
}
