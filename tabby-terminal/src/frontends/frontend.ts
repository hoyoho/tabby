import { Injector } from '@angular/core'
import { Observable, Subject, AsyncSubject, ReplaySubject, BehaviorSubject } from 'rxjs'
import { BaseTerminalProfile, ResizeEvent } from '../api/interfaces'

export interface SearchOptions {
    regex?: boolean
    wholeWord?: boolean
    caseSensitive?: boolean
    incremental?: true
}

export interface SearchState {
    resultIndex?: number
    resultCount: number
}

/**
 * JSON-safe snapshot of every terminal-global DEC/ANSI mode a TUI application
 * may have enabled (alt screen, mouse tracking, bracketed paste, kitty-era
 * hygiene like cursor visibility, ...). Carried inside recovery tokens on
 * workspace-drag transfers so a fresh frontend attached to the same live
 * session can be brought back to the exact state the remote app believes in.
 */
export interface TerminalModeSnapshot {
    altScreen: boolean
    mouseProtocol: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
    mouseEncoding: 'DEFAULT' | 'SGR' | 'URXVT'
    bracketedPaste: boolean
    sendFocus: boolean
    appCursorKeys: boolean
    appKeypad: boolean
    originMode: boolean
    insertMode: boolean
    wraparound: boolean
    reverseWraparound: boolean
    cursorHidden: boolean
    /** 0-based top/bottom margins; absent when default or unreadable. */
    scrollRegion?: [number, number]
}

/**
 * Extend to add support for a different VT frontend implementation
 */
export abstract class Frontend {
    enableResizing = true
    protected ready = new AsyncSubject<void>()
    protected title = new ReplaySubject<string>(1)
    protected alternateScreenActive = new BehaviorSubject<boolean>(false)
    protected mouseEvent = new Subject<MouseEvent>()
    protected bell = new Subject<void>()
    protected contentUpdated = new Subject<void>()
    protected input = new Subject<Buffer>()
    protected resize = new ReplaySubject<ResizeEvent>(1)
    protected dragOver = new Subject<DragEvent>()
    protected drop = new Subject<DragEvent>()
    protected destroyed = new Subject<void>()

    get ready$ (): Observable<void> { return this.ready }
    get title$ (): Observable<string> { return this.title }
    get alternateScreenActive$ (): Observable<boolean> { return this.alternateScreenActive }
    get mouseEvent$ (): Observable<MouseEvent> { return this.mouseEvent }
    get bell$ (): Observable<void> { return this.bell }
    get contentUpdated$ (): Observable<void> { return this.contentUpdated }
    get input$ (): Observable<Buffer> { return this.input }
    get resize$ (): Observable<ResizeEvent> { return this.resize }
    get dragOver$ (): Observable<DragEvent> { return this.dragOver }
    get drop$ (): Observable<DragEvent> { return this.drop }
    get destroyed$ (): Observable<void> { return this.destroyed }

    constructor (protected injector: Injector) { }

    destroy (): void {
        this.destroyed.next()
        for (const o of [
            this.ready,
            this.title,
            this.alternateScreenActive,
            this.mouseEvent,
            this.bell,
            this.contentUpdated,
            this.input,
            this.resize,
            this.dragOver,
            this.drop,
            this.destroyed,
        ]) {
            o.complete()
        }
    }

    abstract attach (host: HTMLElement, profile: BaseTerminalProfile): Promise<void>
    detach (host: HTMLElement): void { } // eslint-disable-line

    abstract getSelection (): string
    abstract copySelection (): void
    abstract selectAll (): void
    abstract clearSelection (): void
    abstract focus (): void
    abstract write (data: string): Promise<void>
    abstract clear (): void
    abstract visualBell (): void

    abstract scrollToTop (): void
    abstract scrollLines (amount: number): void
    abstract scrollPages (pages: number): void
    abstract scrollToBottom (): void

    abstract configure (profile: BaseTerminalProfile): void
    abstract setZoom (zoom: number): void

    abstract findNext (term: string, searchOptions?: SearchOptions): SearchState
    abstract findPrevious (term: string, searchOptions?: SearchOptions): SearchState
    abstract cancelSearch (): void

    abstract saveState (): any
    abstract restoreState (state: any, modes?: TerminalModeSnapshot | null): void

    /**
     * Capture the current terminal-global mode state for a live-session
     * transfer. Frontends that keep no migrateable state return null.
     */
    getTerminalModeSnapshot (): TerminalModeSnapshot | null { return null }

    abstract supportsBracketedPaste (): boolean
    abstract isAlternateScreenActive (): boolean

    /**
     * Reset terminal modes (mouse tracking, bracketed paste, etc.)
     * Called on session reconnection to prevent stale modes from leaking
     */
    resetTerminalModes (): void { } // eslint-disable-line

    /**
     * Broadcast (focus-all) support: pretend the terminal is focused so its
     * cursor blinks without moving the real DOM focus. `false` restores the
     * normal focus-follows-DOM behavior.
     */
    setForcedFocus (_enabled: boolean): void { } // eslint-disable-line
}
