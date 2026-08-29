import { BrowserWindow, ipcMain, screen } from 'electron'
import { Application } from './app'
import { Window } from './window'

/**
 * Cross-window drag coordinator (Chrome-style "drag a tab out of this window
 * and drop it onto another window").
 *
 * The source renderer reports the drag (`app:window-drag-start`) once its
 * gesture crosses the window bounds. The main process then polls the cursor
 * position and maps it onto the open windows. When several windows overlap,
 * the one on top wins (z-order heuristic: always-on-top first, then the most
 * recently activated window, then the most recently created one). This makes
 * a drop land in the *top-most* Tabby window under the cursor rather than a
 * random covered one.
 *
 * The source also sends a ghost card (`app:window-drag-card` { title, color })
 * right when the drag is initiated, so a small labeled card follows the cursor
 * until the drag ends — lightweight, reliable "detached tab" feedback.
 *
 * Events:
 *  - source crosses bounds        → `app:window-drag-start` { token, kind }
 *  - source sends ghost card      → `app:window-drag-card` { title, color }
 *  - main maps cursor → window    → `window:drag-enter` { token, kind, x, y } /
 *                                   `window:drag-move` { x, y } / `window:drag-leave`
 *  - source pointer-up            → `app:window-drag-end` → `window:drag-commit` { token, kind }
 *                                   to the target (or `window:drag-cancelled` to the source)
 *  - target rebuilt the tab       → `app:window-drag-accepted` → `window:drag-committed`
 *                                   back to the source (it may now drop its copy)
 */
export function setupWindowDrag (application: Application): void {
    interface ActiveDrag {
        sourceId: number
        kind: 'workspace'|'session'
        token: any
        target: Window|null
        timer: NodeJS.Timeout|null
        lastActivityAt: number
    }

    interface PendingAccept {
        sourceId: number
        target: Window
    }

    let drag: ActiveDrag|null = null
    let pendingAccept: PendingAccept|null = null
    let ghost: BrowserWindow|null = null
    // The renderer sends the drag card synchronously at drag-start while the
    // recovery token is still being serialized asynchronously; hold it here so
    // the ghost can be built the moment the drag actually starts.
    let pendingCard: { title: string, color?: string|null }|null = null
    const POLL_MS = 50
    const DRAG_STALE_MS = 5000

    function windowById (id: number): Window|null {
        return application.getWindows().find(w => w.webContents.id === id) ?? null
    }

    function windowUnder (pt: { x: number, y: number }, excludeId: number): Window|null {
        const candidates = application.getWindows()
            .filter(w => w.webContents.id !== excludeId)
            .filter(w => {
                const b = w.bounds
                return (
                    pt.x >= b.x && pt.x <= b.x + b.width &&
                    pt.y >= b.y && pt.y <= b.y + b.height
                )
            })
        if (!candidates.length) {
            return null
        }
        // z-order heuristic — pick the top-most of the overlapping windows:
        // always-on-top ⟶ most recently focused ⟶ most recently created.
        candidates.sort((a, b) => {
            const aOntop = a.isAlwaysOnTop
            const bOntop = b.isAlwaysOnTop
            if (aOntop !== bOntop) {
                return aOntop ? -1 : 1
            }
            return b.activatedAt - a.activatedAt
        })
        return candidates[0]
    }

    function ghostHtml (title: string, color: string|null): string {
        const isDark = color && /^#[0-9a-fA-F]{6}$/.test(color)
        const bg = isDark ? color : '#3a3d41'
        const safe = title
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
            html,body{ margin:0; padding:0; background:transparent; overflow:hidden;
                width:100%; height:100%;
                font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
            body{ display:flex; align-items:center; justify-content:center; }
            .card{
                max-width:240px;
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
                padding:6px 14px; border-radius:8px;
                background:${bg}; color:#fff;
                font-size:13px; font-weight:500; text-align:center;
                box-shadow:0 6px 22px rgba(0,0,0,.45);
            }
        </style></head><body><div class="card">${safe}</div></body></html>`
    }

    async function setCard (card: { title: string, color?: string|null }): Promise<void> {
        try {
            if (!ghost || ghost.isDestroyed()) {
                ghost = new BrowserWindow({
                    width: 200,
                    height: 30,
                    frame: false,
                    transparent: true,
                    resizable: false,
                    movable: false,
                    minimizable: false,
                    maximizable: false,
                    fullscreenable: false,
                    skipTaskbar: true,
                    show: false,
                    alwaysOnTop: true,
                    focusable: false,
                    hasShadow: false,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                        sandbox: true,
                    },
                })
                ghost.setIgnoreMouseEvents(true, { forward: true })
                ghost.setAlwaysOnTop(true, 'screen-saver')
                ghost.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
            }
            await ghost.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
                ghostHtml(card.title, card.color ?? null),
            ))
            // Measure the actual card, then set the window to exactly that size
            // so the card (centered in the window) is centered on the cursor.
            const cardRect: { width: number, height: number } = await ghost.webContents.executeJavaScript(
                '(() => { const c = document.querySelector(".card"); const r = c.getBoundingClientRect(); return { width: r.width, height: r.height }; })()',
            )
            const w = Math.max(Math.round(cardRect.width), 4)
            const h = Math.max(Math.round(cardRect.height), 4)
            ghost.setContentSize(w, h)
            ghost.showInactive()
            const pt = screen.getCursorScreenPoint()
            // The card covers the cursor (like a tab held under the pointer) —
            // center the card on the pointer instead of offsetting it.
            ghost.setPosition(Math.round(pt.x - w / 2), Math.round(pt.y - h / 2))
        } catch (err) {
            console.error('[windowDrag] ghost card failed:', err)
        }
    }

    function destroyGhost (): void {
        if (ghost && !ghost.isDestroyed()) {
            ghost.destroy()
        }
        ghost = null
    }

    function stopDrag (): void {
        if (drag?.timer) {
            clearInterval(drag.timer)
        }
        drag = null
        pendingCard = null
        destroyGhost()
    }

    function startPolling (): void {
        drag!.timer = setInterval(() => {
            const d = drag
            if (!d) {
                return
            }
            const pt = screen.getCursorScreenPoint()

            if (Date.now() - d.lastActivityAt > DRAG_STALE_MS) {
                if (d.target) {
                    d.target.send('window:drag-leave')
                }
                stopDrag()
                return
            }

            const target = windowUnder(pt, d.sourceId)
            if (target !== d.target) {
                if (d.target) {
                    d.target.send('window:drag-leave')
                }
                if (target) {
                    target.send('window:drag-enter', { token: d.token, kind: d.kind, x: pt.x, y: pt.y })
                }
                d.target = target
            } else if (target) {
                target.send('window:drag-move', { x: pt.x, y: pt.y })
            }

            // Follow the cursor with the ghost card — centered on the pointer
            // so the card stays under the mouse (Chrome-style held tab).
            if (ghost && !ghost.isDestroyed()) {
                const ghostSize = ghost.getContentSize()
                const ghostW = (ghostSize[0] as number) || 0
                const ghostH = (ghostSize[1] as number) || 0
                ghost.setPosition(Math.round(pt.x - ghostW / 2), Math.round(pt.y - ghostH / 2))
            }
        }, POLL_MS)
    }

    ipcMain.on('app:window-drag-start', (event, payload) => {
        if (drag || pendingAccept) {
            return
        }
        drag = {
            sourceId: event.sender.id,
            kind: payload?.kind === 'session' ? 'session' : 'workspace',
            token: payload?.token,
            target: null,
            timer: null,
            lastActivityAt: Date.now(),
        }
        // The drag card may have arrived before the token/drag-start finished
        // serializing — build the ghost now if we already have it.
        if (pendingCard) {
            const card = pendingCard
            pendingCard = null
            void setCard(card)
        }
        startPolling()
    })

    ipcMain.on('app:window-drag-card', async (event, card) => {
        const d = drag
        if (d && event.sender.id === d.sourceId) {
            await setCard(card)
            return
        }
        // Drag not started yet — stash the card; the drag-start will use it.
        if (card) {
            pendingCard = card
        }
    })

    // The source pointer was released. Commit to the window currently under
    // the cursor (if any), otherwise cancel.
    ipcMain.on('app:window-drag-end', event => {
        const d = drag
        if (!d || d.sourceId !== event.sender.id) {
            return
        }
        if (d.target) {
            d.target.send('window:drag-commit', { token: d.token, kind: d.kind })
            pendingAccept = { sourceId: d.sourceId, target: d.target }
        } else {
            event.sender.send('window:drag-cancelled')
        }
        stopDrag()
    })

    // The receiving window signals that it finished restoring the moved tab;
    // now tell the source window it can drop its copy.
    ipcMain.on('app:window-drag-accepted', event => {
        const p = pendingAccept
        if (!p || p.target.webContents.id !== event.sender.id) {
            return
        }
        const source = windowById(p.sourceId)
        if (source) {
            source.send('window:drag-committed')
        }
        pendingAccept = null
    })

    ipcMain.on('app:window-drag-cancel', event => {
        const d = drag
        if (d && d.sourceId === event.sender.id) {
            if (d.target) {
                d.target.send('window:drag-leave')
            }
            stopDrag()
        } else {
            // A card may have been stashed before the drag ever started — the
            // source aborted (pointer re-entered the window). Drop it.
            pendingCard = null
            destroyGhost()
        }
    })
}
