import { ipcMain, screen } from 'electron'
import { Application } from './app'

/**
 * Main-process tracking for native (HTML5/system DnD) drags.
 *
 * The drag itself is driven entirely by the operating system's native drag &
 * drop (the renderer sets the payload into the DataTransfer at dragstart and
 * the compositor renders the drag image). The main process only needs to
 * correlate a drop that landed in *another* window back to the source window,
 * plus carry the out-of-band state that must not ride in the DataTransfer
 * (cross-process custom-DnD blobs are size-limited and can be dropped by the
 * compositor, which would intermittently kill the drop):
 *
 *  - source renderer  `app:native-drag-start {dragId, savedState}` → remember
 *                      sender + the serialized state (session screen state,
 *                      or the workspace recovery token once it finished
 *                      serializing asynchronously)
 *  - source renderer  `app:native-drag-state-update {dragId, state}` → replace
 *                      the registered state (workspace tokens)
 *  - receiving window `app:native-drag-state {dragId}` → return the state
 *                      (sync); null once the source released the drag
 *  - receiving window successfully restored the drag
 *                    `app:native-drag-accepted {dragId}` → notify the source
 *  - source renderer `window:native-drag-committed {dragId}` → drop local copy
 *  - source renderer `app:native-drag-end {dragId}`     → forget (no drop)
 */
export function setupNativeDrag (application: Application): void {
    const sources = new Map<string, { webContentsId: number, savedState: any }>()

    ipcMain.on('app:native-drag-start', (event, dragId, savedState) => {
        sources.set(String(dragId), { webContentsId: event.sender.id, savedState })
    })

    ipcMain.on('app:native-drag-state-update', (event, dragId, state) => {
        const entry = sources.get(String(dragId))
        if (entry && entry.webContentsId === event.sender.id) {
            entry.savedState = state
        }
    })

    ipcMain.on('app:native-drag-end', (_event, dragId) => {
        sources.delete(String(dragId))
    })

    ipcMain.on('app:native-drag-state', (event, dragId) => {
        event.returnValue = sources.get(String(dragId))?.savedState ?? null
    })

    ipcMain.on('app:native-drag-accepted', (_event, dragId) => {
        const entry = sources.get(String(dragId))
        sources.delete(String(dragId))
        if (entry === undefined) {
            return
        }
        const source = application.getWindows().find(w => w.webContents.id === entry.webContentsId)
        source?.send('window:native-drag-committed', String(dragId))
    })

    // Placement query for a detached workspace's new window (drag released
    // outside every window): the renderer cannot know the OS cursor position.
    ipcMain.on('app:get-cursor-screen-point', event => {
        event.returnValue = screen.getCursorScreenPoint()
    })
}
