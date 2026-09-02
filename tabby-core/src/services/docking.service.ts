import { BehaviorSubject, Observable, Subject } from 'rxjs'

export type DockSide = 'off'|'left'|'right'|'top'|'bottom'

export abstract class Screen {
    id: number
    name?: string
}

export abstract class DockingService {
    get screensChanged$ (): Observable<void> { return this.screensChanged }
    protected screensChanged = new Subject<void>()

    private _dockSide = new BehaviorSubject<DockSide>('off')

    /** Current dock side of this window. Session-scoped, never persisted. */
    get dockSide$ (): Observable<DockSide> { return this._dockSide.asObservable() }

    get dockSide (): DockSide { return this._dockSide.getValue() }

    get isDocked (): boolean { return this._dockSide.getValue() !== 'off' }

    setDockSide (side: DockSide): void {
        this._dockSide.next(side)
        this.dock()
    }

    abstract dock (): void
    abstract getScreens (): Screen[]
}
