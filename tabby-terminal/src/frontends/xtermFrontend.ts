import deepEqual from 'deep-equal'
import { BehaviorSubject, filter, firstValueFrom, fromEvent, takeUntil } from 'rxjs'
import { Injector } from '@angular/core'
import { ConfigService, getCSSFontFamily, getWindows10Build, HostAppService, HotkeysService, Platform, PlatformService, TerminalColorScheme, ThemesService } from 'tabby-core'
import { Frontend, SearchOptions, SearchState, TerminalModeSnapshot } from './frontend'
import { Terminal, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { LigaturesAddon } from '@xterm/addon-ligatures'
import { ISearchOptions, SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SerializeAddon } from '@xterm/addon-serialize'
import { ImageAddon } from '@xterm/addon-image'
import { CanvasAddon } from '@xterm/addon-canvas'
import { BaseTerminalProfile } from '../api/interfaces'
import { getXtermBackgroundColor } from '../helpers'
import { generatePalette } from '../generatePalette'
import './xterm.css'

const COLOR_NAMES = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
]

/**
 * Parse a #rgb / #rrggbb / #rrggbbaa color string into r,g,b(,a) components.
 * Returns null if the string cannot be parsed.
 */
function parseColor (color: string): { r: number, g: number, b: number, a: number } | null {
    const m = /^#([0-9a-f]{3,8})$/i.exec(color)
    if (!m) {
        return null
    }
    let hex = m[1]
    if (hex.length === 3) {
        hex = hex.split('').map(c => c + c).join('')
    }
    if (hex.length === 4) {
        hex = hex.split('').map(c => c + c).join('')
    }
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return { r, g, b, a }
}

/**
 * Blend a semi-transparent foreground color over an opaque background and
 * return the resulting opaque color as #rrggbb. If the foreground has no
 * alpha channel or is already opaque it is returned unchanged.
 */
function blendOverBackground (foreground: string, background: string): string {
    const fg = parseColor(foreground)
    const bg = parseColor(background)
    if (!fg || !bg || fg.a >= 1) {
        return foreground
    }
    const a = fg.a
    const r = Math.round(fg.r * a + bg.r * (1 - a))
    const g = Math.round(fg.g * a + bg.g * (1 - a))
    const b = Math.round(fg.b * a + bg.b * (1 - a))
    return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

// How many times to recreate the WebGL renderer after a lost GPU context
// before giving up and letting xterm fall back to its DOM renderer.
const MAX_WEBGL_RECOVERY_ATTEMPTS = 3

class FlowControl {
    private blocked = false
    private blocked$ = new BehaviorSubject<boolean>(false)
    private pendingCallbacks = 0
    private lowWatermark = 5
    private highWatermark = 10
    private bytesWritten = 0
    private bytesThreshold = 1024 * 128

    constructor (private xterm: Terminal) { }

    async write (data: string) {
        if (this.blocked) {
            await firstValueFrom(this.blocked$.pipe(filter(x => !x)))
        }
        this.bytesWritten += data.length
        if (this.bytesWritten > this.bytesThreshold) {
            this.pendingCallbacks++
            this.bytesWritten = 0
            if (!this.blocked && this.pendingCallbacks > this.highWatermark) {
                this.blocked = true
                this.blocked$.next(true)
            }
            this.xterm.write(data, () => {
                this.pendingCallbacks--
                if (this.blocked && this.pendingCallbacks < this.lowWatermark) {
                    this.blocked = false
                    this.blocked$.next(false)
                }
            })
        } else {
            this.xterm.write(data)
        }
    }
}

/** @hidden */
export class XTermFrontend extends Frontend {
    enableResizing = true
    xterm: Terminal
    protected xtermCore: any
    protected enableWebGL = false
    private element?: HTMLElement
    private configuredFontSize = 0
    private configuredLinePadding = 0
    private zoom = 0
    private resizeHandler: () => void
    private configuredTheme: ITheme = {}
    private copyOnSelect = false
    private preventNextOnSelectionChangeEvent = false
    private search = new SearchAddon()
    /**
     * Listeners registered on the attach host, remembered so detach() can
     * remove them (esp. the capture-phase wheel one) — see detach().
     */
    private hostListeners: { event: string, handler: (e: any) => void, opts?: AddEventListenerOptions }[] = []
    private searchState: SearchState = { resultCount: 0 }
    private fitAddon = new FitAddon()
    private serializeAddon = new SerializeAddon()
    private ligaturesAddon?: LigaturesAddon
    private webGLAddon?: WebglAddon
    private canvasAddon?: CanvasAddon
    private opened = false
    private resizeObserver?: any

    private resizeTimeout?: ReturnType<typeof setTimeout>
    private resizeAnimationFrame?: number
    private resizePending = false
    private disposed = false
    private flowControl: FlowControl
    private pinnedToBottom = true
    private pendingRendererRecovery = false
    private rendererRecoveryAttempts = 0

    // Broadcast (focus-all) state: while forced, the terminal behaves as
    // focused (blinking cursor) even though the real DOM focus is elsewhere.
    private forcedFocus = false
    private originalIsFocusedGetter: (() => boolean)|null = null

    private configService: ConfigService
    private hotkeysService: HotkeysService
    private platformService: PlatformService
    private hostApp: HostAppService
    private themes: ThemesService

    private isAttachActive (): boolean {
        return !this.disposed && this.opened
    }

    constructor (injector: Injector) {
        super(injector)
        this.configService = injector.get(ConfigService)
        this.hotkeysService = injector.get(HotkeysService)
        this.platformService = injector.get(PlatformService)
        this.hostApp = injector.get(HostAppService)
        this.themes = injector.get(ThemesService)

        this.xterm = new Terminal({
            allowTransparency: true,
            allowProposedApi: true,
            overviewRulerWidth: 7,
            windowsPty: process.platform === 'win32' ? {
                backend: this.configService.store.terminal.useConPTY ? 'conpty' : 'winpty',
                buildNumber: getWindows10Build(),
            } : undefined,
        })
        this.flowControl = new FlowControl(this.xterm)
        this.xtermCore = this.xterm['_core']

        // xterm.js#6054 does this in _keyDown itself. Keep the workaround at
        // that boundary so Shift cannot overwrite a previous keydown's state.
        const oldKeyDown = this.xtermCore._keyDown.bind(this.xtermCore)
        this.xtermCore._keyDown = (event: KeyboardEvent) => {
            if (this.hostApp.platform !== Platform.Windows || event.key !== 'Shift' && event.keyCode !== 16) {
                return oldKeyDown(event)
            }

            // Sogou can commit preedit text when Shift switches to English.
            // Preserve the existing value so Shift itself does not arm
            // xterm's input fallback guard.
            const keyDownSeen = this.xtermCore._keyDownSeen
            const result = oldKeyDown(event)
            this.xtermCore._keyDownSeen = keyDownSeen
            return result
        }

        this.xterm.onBinary(data => {
            this.input.next(Buffer.from(data, 'binary'))
        })
        this.xterm.onData(data => {
            this.input.next(Buffer.from(data, 'utf-8'))
        })
        this.xterm.onResize(({ cols, rows }) => {
            this.resize.next({ rows, columns: cols })
        })
        this.xterm.onTitleChange(title => {
            this.title.next(title)
        })
        this.xterm.onSelectionChange(() => {
            if (this.getSelection()) {
                if (this.copyOnSelect && !this.preventNextOnSelectionChangeEvent) {
                    this.copySelection()
                }
                this.preventNextOnSelectionChangeEvent = false
            }
        })
        this.xterm.onBell(() => {
            this.bell.next()
        })

        this.xterm.loadAddon(this.fitAddon)
        this.xterm.loadAddon(this.serializeAddon)
        this.xterm.loadAddon(new Unicode11Addon())
        this.xterm.unicode.activeVersion = '11'

        if (this.configService.store.terminal.sixel) {
            this.xterm.loadAddon(new ImageAddon())
        }

        const keyboardEventHandler = (name: string, event: KeyboardEvent) => {
            if (this.isAlternateScreenActive()) {
                let modifiers = 0
                modifiers += event.ctrlKey ? 1 : 0
                modifiers += event.altKey ? 1 : 0
                modifiers += event.shiftKey ? 1 : 0
                modifiers += event.metaKey ? 1 : 0
                if (event.key.startsWith('Arrow') && modifiers === 1) {
                    return true
                }
            }

            // Ctrl-/
            if (event.type === 'keydown' && event.key === '/' && event.ctrlKey) {
                this.input.next(Buffer.from('\u001f', 'binary'))
                return false
            }

            // Ctrl-@
            if (event.type === 'keydown' && event.key === '@' && event.ctrlKey) {
                this.input.next(Buffer.from('\u0000', 'binary'))
                return false
            }

            this.hotkeysService.pushKeyEvent(name, event)

            let ret = true
            if (this.hotkeysService.matchActiveHotkey(true) !== null) {
                event.stopPropagation()
                event.preventDefault()
                ret = false
            }
            return ret
        }

        this.xterm.attachCustomKeyEventHandler((event: KeyboardEvent) => {
            if (this.hostApp.platform !== Platform.Web) {
                if (
                    event.getModifierState('Meta') && event.key.toLowerCase() === 'v' ||
                    event.key === 'Insert' && event.shiftKey
                ) {
                    event.preventDefault()
                    return false
                }
            }
            if (event.getModifierState('Meta') && event.key.startsWith('Arrow')) {
                return false
            }

            return keyboardEventHandler('keydown', event)
        })

        this.xtermCore._scrollToBottom = this.xtermCore.scrollToBottom.bind(this.xtermCore)
        this.xtermCore.scrollToBottom = () => null

        // NOTE: xterm.onScroll only fires for content-driven scroll (new lines),
        // NOT for user wheel/keyboard scroll (xterm.js #3864, #3201). During
        // fast output, viewportY transiently equals baseY during xterm's
        // internal processing, so onScroll would falsely re-pin. We do NOT
        // use onScroll for pin state. Re-pinning happens only via:
        //   - wheel/keyboard event listeners (below)
        //   - explicit scrollToBottom() calls

        const doResize = () => {
            try {
                if (this.xterm.element && getComputedStyle(this.xterm.element).getPropertyValue('height') !== 'auto') {
                    const savedPinned = this.pinnedToBottom
                    const savedViewportY = this.xterm.buffer.active.viewportY

                    this.fitAddon.fit()
                    this.xtermCore.viewport._refresh()

                    if (savedPinned) {
                        this.xtermCore._scrollToBottom()
                    } else {
                        // Restore the previous scroll position after fit
                        const maxScroll = this.xterm.buffer.active.baseY
                        const targetY = Math.min(savedViewportY, maxScroll)
                        this.xterm.scrollToLine(targetY)
                    }

                    // fitAddon.fit() resizes the renderer's drawing buffer,
                    // which blanks it synchronously, but xterm only repaints on
                    // the next animation frame — leaving one blank frame that
                    // reads as flicker during a window drag. Force the repaint
                    // now (after scrolling settles) to close that gap.
                    this.xtermCore._renderService?._renderRows(0, this.xterm.rows - 1)
                }
            } catch (e) {
                // tends to throw when element wasn't shown yet
                console.warn('Could not resize xterm', e)
            }
        }

        // Rate-limit reflows during a window drag. The window 'resize' event and
        // the ResizeObserver fire many times per frame; each reflow resizes the
        // renderer's drawing buffer and re-uploads the glyph atlas texture. At
        // full frame rate a fast drag issues reflows faster than the GPU can
        // finish one, so frames composite with the text not yet repainted —
        // visible as a flicker that only shows up when dragging quickly (slow
        // drags leave enough time between reflows). Capping the reflow rate and
        // always running a trailing fit keeps the final size correct without
        // outrunning the renderer. Tune RESIZE_MIN_INTERVAL if needed.
        const RESIZE_MIN_INTERVAL = 32
        let lastResize = 0
        const runResize = () => {
            this.resizeAnimationFrame = undefined
            this.resizePending = false
            if (!this.isAttachActive()) {
                return
            }
            lastResize = Date.now()
            doResize()
        }
        this.resizeHandler = () => {
            if (this.resizePending) {
                return
            }
            this.resizePending = true
            const wait = Math.max(0, RESIZE_MIN_INTERVAL - (Date.now() - lastResize))
            if (wait > 0) {
                this.resizeTimeout = setTimeout(() => {
                    this.resizeTimeout = undefined
                    this.resizeAnimationFrame = requestAnimationFrame(runResize)
                }, wait)
            } else {
                this.resizeAnimationFrame = requestAnimationFrame(runResize)
            }
        }

        const oldKeyUp = this.xtermCore._keyUp.bind(this.xtermCore)
        this.xtermCore._keyUp = (e: KeyboardEvent) => {
            this.xtermCore.updateCursorStyle(e)
            if (keyboardEventHandler('keyup', e)) {
                oldKeyUp(e)
            }
        }

        this.xterm.buffer.onBufferChange(() => {
            const altBufferActive = this.xterm.buffer.active.type === 'alternate'
            this.alternateScreenActive.next(altBufferActive)
        })
    }

    private isAtBottom (): boolean {
        const buffer = this.xterm.buffer.active
        return buffer.viewportY >= buffer.baseY - 1
    }

    private updatePinnedState (): void {
        this.pinnedToBottom = this.isAtBottom()
    }

    async attach (host: HTMLElement, profile: BaseTerminalProfile): Promise<void> {
        if (this.disposed) {
            return
        }
        this.element = host

        this.xterm.open(host)
        this.opened = true

        // While broadcast-forced, a real blur (clicking another terminal)
        // clears xterm's focus state — re-assert it on the next tick, after
        // xterm's own blur handler (registered during open()) ran.
        this.xterm.textarea?.addEventListener('blur', () => {
            if (this.forcedFocus) {
                setTimeout(() => {
                    if (this.forcedFocus && this.opened) {
                        this.xtermCore._renderService?.handleFocus()
                    }
                })
            }
        })

        // The forced-focus request may have arrived before the frontend was
        // attached (renderer not created yet) — apply it now.
        if (this.forcedFocus) {
            this.applyForcedFocusState()
        }

        // Work around font loading bugs
        await new Promise(resolve => setTimeout(resolve, this.hostApp.platform === Platform.Web ? 1000 : 0))
        if (!this.isAttachActive()) {
            return
        }

        // Just configure the colors to avoid a flash
        this.configureColors(profile.terminalColorScheme)

        if (this.enableWebGL) {
            this.attachWebGLAddon()
            this.platformService.displayMetricsChanged$.pipe(
                takeUntil(this.destroyed$),
            ).subscribe(() => {
                this.webGLAddon?.clearTextureAtlas()
            })
        } else {
            this.canvasAddon = new CanvasAddon()
            this.xterm.loadAddon(this.canvasAddon)
            // The canvas renderer stacks the selection layer above the text
            // layer, so the semi-transparent selection background tints the
            // selectionForeground text. Swap them so text paints on top.
            this.fixCanvasLayerOrder()
            this.platformService.displayMetricsChanged$.pipe(
                takeUntil(this.destroyed$),
            ).subscribe(() => {
                this.canvasAddon?.clearTextureAtlas()
            })
        }

        // Allow an animation frame
        await new Promise(r => setTimeout(r, 100))
        if (!this.isAttachActive()) {
            return
        }

        this.ready.next()
        this.ready.complete()

        this.xterm.loadAddon(this.search)

        this.search.onDidChangeResults(state => {
            this.searchState = state
        })

        window.addEventListener('resize', this.resizeHandler)

        // The GPU context is often dropped while the app is in the background;
        // retry recovery once the window is focused again and WebGL is usable.
        fromEvent(window, 'focus').pipe(
            takeUntil(this.destroyed$),
        ).subscribe(() => this.recoverRenderer())

        this.resizeHandler()

        // Allow an animation frame
        await new Promise(r => setTimeout(r, 0))
        if (!this.isAttachActive()) {
            return
        }

        // User-initiated scroll detection: only wheel and keyboard events
        // should unpin. xterm.onScroll is content-driven only and must never
        // unpin (see constructor comment). Use capture phase — xterm.js
        // handles wheel/key events on its internal viewport element and may
        // stop propagation, so bubbling listeners on host would never fire.
        this.addHostListener('wheel', (event: WheelEvent) => {
            // Immediately unpin on scroll-up so that writes arriving before
            // the next animation frame don't yank the viewport back down.
            if (event.deltaY < 0) {
                this.pinnedToBottom = false
            }
            requestAnimationFrame(() => this.updatePinnedState())
        }, { capture: true, passive: true })

        // Native scrollbar drag (thumb / track click) does NOT emit wheel or
        // keyboard events, so the handlers above would leave pinnedToBottom
        // stale at `true`. The next write() would then re-scroll to the bottom
        // even though the user explicitly dragged away from it. The DOM
        // `scroll` event on xterm's viewport covers every scroll source
        // (scrollbar drag, wheel, keyboard, programmatic — including the
        // search addon's scrollToLine to reveal a match), so we re-evaluate
        // pin state from the actual viewport position. Unlike xterm.onScroll
        // this fires for user drags too; the transient-false-positive concern
        // from the constructor comment does not apply here because scrollTop
        // only changes when the viewport actually moves.
        //
        // Update SYNCHRONOUSLY (no rAF): the search addon scrolls to a match
        // and then a concurrent write() may run within the same task. If
        // pinnedToBottom were still stale `true`, write() would capture
        // wasPinned=true and yank the viewport back to the bottom, undoing the
        // search reveal. Updating here closes that race window.
        const viewport = this.xterm.element?.querySelector('.xterm-viewport') as HTMLElement | null
        if (viewport) {
            viewport.addEventListener('scroll', () => {
                this.updatePinnedState()
            }, { passive: true })

            // The scrollbar thumb is rendered thin by default and should
            // expand to the full rail width when the pointer enters the rail
            // area. WebKit offers no CSS combinator for "track hover affects
            // thumb" (::-webkit-scrollbar:hover does not propagate to
            // ::-webkit-scrollbar-thumb), so we detect the right-edge hover
            // band in JS and toggle a class. SCROLLBAR_WIDTH mirrors the
            // 7px rail declared in xterm.css.
            const SCROLLBAR_WIDTH = 7

            // Clicking the scrollbar (thumb / track) must not clear the
            // terminal selection. xterm attaches a `mousedown` listener on the
            // `.xterm` element that unconditionally starts a new selection
            // (and therefore wipes the current one). Because the scrollbar is
            // not a real DOM node, the event target is the viewport and it
            // bubbles up to `.xterm`. We catch it here, while still on the
            // viewport, and stop propagation for clicks inside the right-edge
            // rail band. This keeps the search addon's "last match" selection
            // intact across scrollbar drags.
            viewport.addEventListener('mousedown', (e) => {
                const rect = viewport.getBoundingClientRect()
                if (e.clientX >= rect.right - SCROLLBAR_WIDTH) {
                    e.stopImmediatePropagation()
                    // The user grabbed the scrollbar, so the next search
                    // navigation should re-anchor to the viewport instead of
                    // continuing from the last selected match.
                    this.userScrolledSinceLastSearch = true
                }
            })

            const onRailPointerMove = (e: MouseEvent) => {
                const rect = viewport.getBoundingClientRect()
                viewport.classList.toggle('scrollbar-rail-hover', e.clientX >= rect.right - SCROLLBAR_WIDTH)
            }
            const onRailPointerLeave = () => viewport.classList.remove('scrollbar-rail-hover')
            viewport.addEventListener('mousemove', onRailPointerMove)
            viewport.addEventListener('mouseleave', onRailPointerLeave)
        }

        this.hotkeysService.hotkey$
            .pipe(
                takeUntil(this.destroyed$),
                filter(hk => [
                    'scroll-up',
                    'scroll-down',
                    'scroll-page-up',
                    'scroll-page-down',
                    'scroll-to-top',
                    'scroll-to-bottom',
                ].includes(hk)),
            ).subscribe(hk => {
                if ([
                    'scroll-up',
                    'scroll-page-up',
                    'scroll-to-top',
                ].includes(hk)) {
                    this.pinnedToBottom = false
                }
                requestAnimationFrame(() => this.updatePinnedState())
            })

        this.addHostListener('dragOver', (event: any) => this.dragOver.next(event))
        this.addHostListener('drop', event => this.drop.next(event))

        this.addHostListener('mousedown', event => this.mouseEvent.next(event))
        this.addHostListener('mouseup', event => this.mouseEvent.next(event))
        this.addHostListener('mousewheel', event => this.mouseEvent.next(event as MouseEvent))
        this.addHostListener('contextmenu', event => {
            event.preventDefault()
            event.stopPropagation()
        })

        this.resizeObserver = new window['ResizeObserver'](() => this.resizeHandler())
        this.resizeObserver.observe(host)
    }

    /** Registers a host listener and remembers it for detach() cleanup. */
    private addHostListener (event: string, handler: (e: any) => void, opts?: AddEventListenerOptions): void {
        // attach() sets this.element = host before any listener is registered.
        if (!this.element) {
            return
        }
        this.hostListeners.push({ event, handler, opts })
        this.element.addEventListener(event, handler as EventListener, opts)
    }

    detach (_host: HTMLElement): void {
        window.removeEventListener('resize', this.resizeHandler)
        if (this.resizeTimeout !== undefined) {
            clearTimeout(this.resizeTimeout)
            this.resizeTimeout = undefined
        }
        if (this.resizeAnimationFrame !== undefined) {
            cancelAnimationFrame(this.resizeAnimationFrame)
            this.resizeAnimationFrame = undefined
        }
        this.resizePending = false
        this.resizeObserver?.disconnect()
        delete this.resizeObserver
        // Remove every listener attach() registered on the host. Leaving them
        // behind lets a stray wheel/mouse event hit the disposed terminal and
        // crash xterm's viewport sync ("Cannot read properties of undefined
        // (reading 'dimensions')") after the session is closed.
        for (const { event, handler, opts } of this.hostListeners) {
            _host.removeEventListener(event, handler as EventListener, opts)
        }
        this.hostListeners = []
        this.opened = false
        this.element = undefined
    }

    destroy (): void {
        if (this.disposed) {
            return
        }
        this.disposed = true
        if (this.element) {
            this.detach(this.element)
        }
        super.destroy()
        this.webGLAddon?.dispose()
        this.canvasAddon?.dispose()
        this.xterm.dispose()
    }

    getSelection (): string {
        return this.xterm.getSelection()
    }

    copySelection (): void {
        const text = this.getSelection()
        if (!text.trim().length) {
            return
        }
        if (text.length < 1024 * 32 && this.configService.store.terminal.copyAsHTML) {
            this.platformService.setClipboard({
                text: this.getSelection(),
                html: this.getSelectionAsHTML(),
            })
        } else {
            this.platformService.setClipboard({
                text: this.getSelection(),
            })
        }
    }

    selectAll (): void {
        this.xterm.selectAll()
    }

    clearSelection (): void {
        this.xterm.clearSelection()
    }

    focus (): void {
        setTimeout(() => this.xterm.focus())
    }

    /**
     * Broadcast (focus-all) support: makes the terminal act focused (blinking
     * cursor) while the real DOM focus lives elsewhere. Works across all three
     * renderers:
     * - DOM: handleFocus() adds the row-container focus class that gates the
     *   CSS blink animation.
     * - Canvas/WebGL: handleFocus() resumes the blink state manager, and the
     *   shadowed `isFocused` getter keeps the renderer drawing the active
     *   cursor style.
     */
    setForcedFocus (enabled: boolean): void {
        if (this.forcedFocus === enabled) {
            return
        }
        this.forcedFocus = enabled
        // cursorBlink must be on for any blink machinery to exist at all.
        this.xterm.options.cursorBlink = enabled || this.configService.store.terminal.cursorBlink
        if (this.opened) {
            this.applyForcedFocusState()
        }
    }

    private applyForcedFocusState (): void {
        const renderService = this.xtermCore._renderService
        const coreBrowserService = this.xtermCore._coreBrowserService
        if (!renderService || !coreBrowserService) {
            return
        }
        if (this.forcedFocus) {
            this.shadowIsFocused(true)
            renderService.handleFocus()
        } else {
            this.shadowIsFocused(false)
            // Only clear the visual focus state if the terminal does not hold
            // the real DOM focus; otherwise xterm's own state is authoritative.
            if (document.activeElement !== this.xterm.textarea) {
                renderService.handleBlur()
            }
        }
    }

    /**
     * Overrides (or restores) the CoreBrowserService.isFocused accessor on the
     * instance, so renderers treat this terminal as focused while broadcast-
     * forced without touching real DOM focus.
     */
    private shadowIsFocused (enabled: boolean): void {
        const svc = this.xtermCore._coreBrowserService
        if (enabled) {
            if (this.originalIsFocusedGetter) {
                return
            }
            const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(svc), 'isFocused')
            if (!descriptor?.get) {
                return
            }
            this.originalIsFocusedGetter = descriptor.get.bind(svc)
            Object.defineProperty(svc, 'isFocused', { get: () => true, configurable: true })
        } else if (this.originalIsFocusedGetter) {
            Object.defineProperty(svc, 'isFocused', { get: this.originalIsFocusedGetter, configurable: true })
            this.originalIsFocusedGetter = null
        }
    }

    async write (data: string): Promise<void> {
        // ConPTY (Windows local sessions) opens with a full-screen clear +
        // blank repaint, which would wipe a freshly restored scrollback.
        // When armed (right after restoring state), swallow that first clear.
        if (this.suppressNextClearSequence) {
            if (/\x1b\[2J|\x1b\[3J/.test(data)) {
                data = data.replace(/\x1b\[(?:2|3)J/g, '').replace(/\x1b\[H/g, '').replace(/^(?:\r?\n)+/, '')
                this.suppressNextClearSequence = false
            }
        }
        // Capture pinned state before the async write yields to the event loop.
        // pinnedToBottom is kept in sync by the viewport's scroll listener
        // (which fires synchronously for every real scroll, including the
        // search addon's scrollToLine), so re-evaluate it AFTER the await:
        // a search/wheel that scrolled the viewport away from the bottom
        // during the write must not be undone by a stale wasPinned=true.
        const wasPinned = this.pinnedToBottom
        const savedViewportY = this.xterm.buffer.active.viewportY
        await this.flowControl.write(data)
        const nowPinned = this.pinnedToBottom
        const b = this.xterm.buffer.active
        if (nowPinned) {
            this.xtermCore._scrollToBottom()
        } else if (!wasPinned) {
            const targetY = Math.min(savedViewportY, b.baseY)
            if (b.viewportY !== targetY) {
                this.xterm.scrollToLine(targetY)
            }
        }
        // else: wasPinned && !nowPinned — the user scrolled during the write;
        // leave the viewport where they put it.
    }

    clear (): void {
        this.xterm.clear()
    }

    resetTerminalModes (): void {
        // Disable mouse tracking modes (normal, button-event, any-event)
        // and SGR extended mouse mode to prevent stale mouse tracking
        // from leaking escape sequences as text after session reconnection
        this.xterm.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l')
        // Disable bracketed paste mode
        this.xterm.write('\x1b[?2004l')
    }

    visualBell (): void {
        if (this.element) {
            this.element.style.animation = 'none'
            // Force a synchronous reflow so the browser registers the cleared
            // animation before it is reassigned. Without this, repeated bells
            // arriving while a shake is still playing coalesce into a single
            // frame and the animation fails to restart (#11303).
            void this.element.offsetWidth
            this.element.style.animation = 'terminalShakeFrames 0.3s ease'
        }
    }

    scrollToTop (): void {
        this.pinnedToBottom = false
        this.xterm.scrollToTop()
    }

    scrollPages (pages: number): void {
        this.xterm.scrollPages(pages)
        this.updatePinnedState()
    }

    scrollLines (amount: number): void {
        this.xterm.scrollLines(amount)
        this.updatePinnedState()
    }

    scrollToBottom (): void {
        this.pinnedToBottom = true
        this.xtermCore._scrollToBottom()
    }

    /**
     * The xterm canvas renderer creates .xterm-selection-layer above
     * .xterm-text-layer. Because xterm forces the selection background to
     * ~30% opacity, that overlay tints the selectionForeground text. Move
     * the text canvas above the selection canvas so the foreground color
     * stays pure. Only the canvas renderer has separate layers; the WebGL
     * renderer composites everything on a single surface and already
     * honours selectionForeground in its shader.
     */
    private fixCanvasLayerOrder (): void {
        const screen = this.element?.querySelector('.xterm-screen')
        if (!screen) {
            return
        }
        const text = screen.querySelector<HTMLElement>('.xterm-text-layer')
        const selection = screen.querySelector<HTMLElement>('.xterm-selection-layer')
        if (text && selection) {
            text.style.zIndex = '2'
            selection.style.zIndex = '1'
        }
    }

    private configureColors (scheme: TerminalColorScheme | null): void {
        const appColorScheme = this.themes._getActiveColorScheme()

        scheme = scheme ?? appColorScheme

        const background = getXtermBackgroundColor(this.configService, this.themes, scheme)
        // Pre-blend the selection background with the terminal background so
        // the canvas renderer (which uses the transparent variant directly)
        // and the WebGL renderer (which uses the opaque, pre-blended variant)
        // produce the same selection color.
        // xterm's ThemeService forces *opaque* selection backgrounds to 30%
        // opacity (see @xterm/xterm ThemeService.ts, issue #2737). That only
        // affects the canvas renderer, leaving WebGL with the fully opaque
        // color. Append alpha=254 so xterm treats the color as non-opaque and
        // leaves it untouched; 254/255 is visually indistinguishable from
        // fully opaque.
        const blendedSelection = scheme.selection ? blendOverBackground(scheme.selection, background) : undefined
        const selectionBackground = blendedSelection ? `${blendedSelection}FE` : undefined

        const theme: ITheme = {
            foreground: scheme.foreground,
            selectionBackground,
            selectionForeground: scheme.selectionForeground,
            background,
            cursor: scheme.cursor,
            cursorAccent: scheme.cursorAccent,
        }

        for (let i = 0; i < COLOR_NAMES.length; i++) {
            theme[COLOR_NAMES[i]] = scheme.colors[i]
        }

        if (this.configService.store.terminal.paletteGenerate) {
            theme.extendedAnsi = generatePalette(
                scheme.colors,
                scheme.background,
                scheme.foreground,
                this.configService.store.terminal.paletteHarmonious,
            )
        }

        if (!deepEqual(this.configuredTheme, theme)) {
            this.xterm.options.theme = theme
            this.configuredTheme = theme
        }
    }

    configure (profile: BaseTerminalProfile): void {
        const config = this.configService.store

        setImmediate(() => {
            if (this.xterm.cols && this.xterm.rows && this.xtermCore.charMeasure) {
                if (this.xtermCore.charMeasure) {
                    this.xtermCore.charMeasure.measure(this.xtermCore.options)
                }
                if (this.xtermCore.renderer) {
                    this.xtermCore.renderer._updateDimensions()
                }
                this.resizeHandler()
            }
        })

        this.xtermCore.browser.isWindows = this.hostApp.platform === Platform.Windows
        this.xtermCore.browser.isLinux = this.hostApp.platform === Platform.Linux
        this.xtermCore.browser.isMac = this.hostApp.platform === Platform.macOS

        this.xterm.options.fontFamily = getCSSFontFamily(config)
        this.xterm.options.cursorStyle = {
            beam: 'bar',
        }[config.terminal.cursor] || config.terminal.cursor
        this.xterm.options.cursorBlink = this.forcedFocus || config.terminal.cursorBlink
        this.xterm.options.macOptionIsMeta = config.terminal.altIsMeta
        this.xterm.options.scrollback = config.terminal.scrollbackLines
        this.xterm.options.wordSeparator = config.terminal.wordSeparator
        this.xterm.options.drawBoldTextInBrightColors = config.terminal.drawBoldTextInBrightColors
        this.xterm.options.fontWeight = config.terminal.fontWeight
        this.xterm.options.fontWeightBold = config.terminal.fontWeightBold
        this.xterm.options.minimumContrastRatio = config.terminal.minimumContrastRatio
        this.configuredFontSize = config.terminal.fontSize
        this.configuredLinePadding = config.terminal.linePadding
        this.setFontSize()

        this.copyOnSelect = config.terminal.copyOnSelect

        this.configureColors(profile.terminalColorScheme)

        if (this.opened && config.terminal.ligatures && !this.ligaturesAddon && this.hostApp.platform !== Platform.Web) {
            this.ligaturesAddon = new LigaturesAddon()
            this.xterm.loadAddon(this.ligaturesAddon)
        }
    }

    setZoom (zoom: number): void {
        this.zoom = zoom
        this.setFontSize()
        this.resizeHandler()
    }

    private getSearchOptions (searchOptions?: SearchOptions): ISearchOptions {
        return {
            ...searchOptions,
            decorations: {
                matchOverviewRuler: '#888888',
                activeMatchColorOverviewRuler: '#ffff00',
                matchBackground: '#888888',
                activeMatchBackground: '#ffff00',
            },
        }
    }

    private wrapSearchResult (result: boolean): SearchState {
        if (!result) {
            return { resultCount: 0 }
        }
        return this.searchState
    }

    /**
     * Set when the user interacts with the scrollbar (drag / track click).
     * The next findNext/findPrevious call then re-anchors the search to the
     * current viewport instead of continuing from the last selected match,
     * so navigation resumes from wherever the user chose to look.
     */
    private userScrolledSinceLastSearch = false

    /**
     * Decides where the next search starts from.
     *  - Default: leave the current selection alone, so the SearchAddon
     *    continues from the last match (natural up/down navigation, and
     *    right-click → Search on a selected keyword).
     *  - If the user grabbed the scrollbar since the last search: re-anchor
     *    to the viewport so browsing resumes from the visible area.
     *  - If there is no selection at all (fresh search with no prior match):
     *    anchor to the viewport rather than the top of the buffer.
     */
    private prepareSearchAnchor (direction: 'next' | 'previous'): void {
        const anchorToViewport = this.userScrolledSinceLastSearch || !this.xterm.hasSelection()
        this.userScrolledSinceLastSearch = false
        if (!anchorToViewport) {
            return
        }
        const viewportY = this.xterm.buffer.active.viewportY
        const row = direction === 'next' ? viewportY : viewportY + this.xterm.rows - 1
        this.xterm.select(0, row, 1)
    }

    findNext (term: string, searchOptions?: SearchOptions): SearchState {
        if (this.copyOnSelect) {
            this.preventNextOnSelectionChangeEvent = true
        }
        this.prepareSearchAnchor('next')
        const result = this.search.findNext(term, this.getSearchOptions(searchOptions))
        this.updatePinnedState()
        return this.wrapSearchResult(result)
    }

    findPrevious (term: string, searchOptions?: SearchOptions): SearchState {
        if (this.copyOnSelect) {
            this.preventNextOnSelectionChangeEvent = true
        }
        this.prepareSearchAnchor('previous')
        const result = this.search.findPrevious(term, this.getSearchOptions(searchOptions))
        this.updatePinnedState()
        return this.wrapSearchResult(result)
    }

    cancelSearch (): void {
        this.search.clearDecorations()
        this.focus()
    }

    /**
     * Serialize both buffers (primary with scrollback + alternate screen when
     * active). Modes are NOT part of the serialized stream; they travel in the
     * [[TerminalModeSnapshot]] produced by [[getTerminalModeSnapshot]].
     */
    saveState (): any {
        const serializeOptions = {
            excludeModes: true,
            // Honor the user's configured scrollback so drag transfers and
            // recovery snapshots carry the full visible history.
            scrollback: this.configService.store.terminal.scrollbackLines,
        }
        return {
            v: 2,
            primary: this.serializeAddon.serialize({ ...serializeOptions, excludeAltBuffer: true }),
            alternate: this.isAlternateScreenActive()
                ? this.serializeAddon.serialize({ ...serializeOptions, excludeAltBuffer: false })
                : null,
        }
    }

    /**
     * Capture every terminal-global DEC/ANSI mode plus the mouse encoding so a
     * fresh frontend attached to the same live session (workspace drag) can be
     * brought back to the exact state the remote application believes it is in.
     * Only JSON-safe values: the snapshot travels inside recovery tokens.
     */
    getTerminalModeSnapshot (): TerminalModeSnapshot {
        // xterm 5.4 keeps the mouse encoding, cursor visibility and scroll
        // margins off its public API; read them through the internal core with
        // defensive access so an xterm upgrade degrades to defaults, never to
        // a crash.
        const core = (this.xterm as any)._core
        const mouseService = core?.coreMouseService
        // `core.buffer` is the active buffer; margins are 0-based `scrollTop` /
        // `scrollBottom` (default 0 / rows-1), not `scrollTopMargin` and not
        // under a `bufferService` property.
        const buffer = core?.buffer
        const scrollTop = buffer?.scrollTop
        const scrollBottom = buffer?.scrollBottom
        return {
            altScreen: this.isAlternateScreenActive(),
            mouseProtocol: this.xterm.modes.mouseTrackingMode,
            // Fallback SGR: xterm only accepts 1006/1015 DECSETs, so when the
            // internal read fails the active encoding is SGR in practice.
            mouseEncoding: mouseService?.activeEncoding ?? 'SGR',
            bracketedPaste: this.xterm.modes.bracketedPasteMode,
            sendFocus: this.xterm.modes.sendFocusMode,
            appCursorKeys: this.xterm.modes.applicationCursorKeysMode,
            appKeypad: this.xterm.modes.applicationKeypadMode,
            originMode: this.xterm.modes.originMode,
            insertMode: this.xterm.modes.insertMode,
            wraparound: this.xterm.modes.wraparoundMode,
            reverseWraparound: this.xterm.modes.reverseWraparoundMode,
            cursorHidden: core?.coreService?.isCursorHidden ?? false,
            ...typeof scrollTop === 'number' && typeof scrollBottom === 'number'
                && (scrollTop !== 0 || scrollBottom !== this.xterm.rows - 1)
                ? { scrollRegion: [scrollTop, scrollBottom] as [number, number] }
                : {},
        }
    }

    private suppressNextClearSequence = false

    /**
     * Arm right after restoring scrollback state: swallows the initial
     * full-screen clear that ConPTY emits when a Windows session starts,
     * which would otherwise wipe the freshly restored history.
     */
    armClearSuppression (): void {
        this.suppressNextClearSequence = true
    }

    restoreState (state: any, modes?: TerminalModeSnapshot | null): void {
        let altScreenEntered = false
        if (state && typeof state === 'object' && 'primary' in state) {
            this.xterm.write(state.primary)
            if (state.alternate) {
                // 1049 = save cursor + switch to the alternate screen + clear
                // it. Entering alt is content-coupled (the alt content must be
                // written AFTER the switch), so it is owned here, never in
                // mode replay.
                this.xterm.write('\x1b[?1049h')
                this.xterm.write(state.alternate)
                altScreenEntered = true
            }
        } else if (state) {
            // Legacy snapshots (pre-v2) are plain serialized strings of the
            // primary buffer only.
            this.xterm.write(state)
        }
        if (modes) {
            if (modes.altScreen && !altScreenEntered) {
                // Legacy path or snapshot/content mismatch: re-enter the alt
                // screen anyway (blank until the app repaints on SIGWINCH).
                this.xterm.write('\x1b[?1049h')
            }
            this.writeModeReplay(modes)
        }
    }

    /**
     * Re-emit every terminal-global mode EXCEPT the alt screen switch (which
     * is content-coupled and handled by restoreState), mirroring
     * [[resetTerminalModes]]. The kitty keyboard protocol is deliberately
     * absent: xterm 5.4 does not implement it, so no kitty state exists here
     * to migrate (apps fall back to legacy encodings via capability detect).
     */
    private writeModeReplay (m: TerminalModeSnapshot): void {
        let seq = ''
        if (m.appCursorKeys) { seq += '\x1b[?1h' }
        if (m.appKeypad) { seq += '\x1b[?66h' }
        if (m.originMode) { seq += '\x1b[?6h' }
        if (m.insertMode) { seq += '\x1b[4h' }
        if (!m.wraparound) { seq += '\x1b[?7l' }
        if (m.reverseWraparound) { seq += '\x1b[?45h' }
        switch (m.mouseProtocol) {
            case 'none': break
            case 'x10': seq += '\x1b[?9h'; break
            case 'vt200': seq += '\x1b[?1000h'; break
            case 'drag': seq += '\x1b[?1002h'; break
            case 'any': seq += '\x1b[?1003h'; break
        }
        if (m.mouseProtocol !== 'none' && m.mouseEncoding === 'SGR') { seq += '\x1b[?1006h' }
        if (m.mouseProtocol !== 'none' && m.mouseEncoding === 'URXVT') { seq += '\x1b[?1015h' }
        if (m.sendFocus) { seq += '\x1b[?1004h' }
        if (m.bracketedPaste) { seq += '\x1b[?2004h' }
        if (m.cursorHidden) { seq += '\x1b[?25l' }
        if (m.scrollRegion) {
            seq += `\x1b[${m.scrollRegion[0] + 1};${m.scrollRegion[1] + 1}r`
        }
        if (seq) {
            this.xterm.write(seq)
        }
    }

    supportsBracketedPaste (): boolean {
        return this.xterm.modes.bracketedPasteMode
    }

    isAlternateScreenActive (): boolean {
        return this.xterm.buffer.active.type === 'alternate'
    }

    private setFontSize () {
        const scale = Math.pow(1.1, this.zoom)
        this.xterm.options.fontSize = this.configuredFontSize * scale
        // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
        this.xterm.options.lineHeight = Math.max(1, (this.configuredFontSize + this.configuredLinePadding * 2) / this.configuredFontSize)
        this.resizeHandler()
    }

    /**
     * Redraw the terminal and recover the renderer when its tab is shown again.
     * Reactivating clears stale renderer state left behind while the tab was
     * hidden, and flushes any GPU context recovery deferred until now.
     */
    reactivate (): void {
        // An app- or window-level GPU reset can blank the canvas without firing
        // xterm's per-canvas contextlost event, so pendingRendererRecovery stays
        // unset. Treat a WebGL frontend that has lost its addon as needing
        // recovery too, so a shown-but-blank pane always gets its context back
        // instead of relying on a manual window resize.
        if (this.pendingRendererRecovery || this.enableWebGL && !this.webGLAddon) {
            this.pendingRendererRecovery = true
            this.recoverRenderer()
        } else {
            // The pane is shown with a live renderer, so any earlier transient
            // losses shouldn't count against a future recovery — reset the budget
            // to avoid permanently downgrading the pane to the DOM renderer.
            this.rendererRecoveryAttempts = 0
            this.redraw()
        }
    }

    private attachWebGLAddon (): void {
        const addon = new WebglAddon()
        // xterm fires this when the GPU drops the canvas context (driver reset,
        // backgrounded app, too many live contexts).
        addon.onContextLoss(() => this.onWebGLContextLoss())
        this.xterm.loadAddon(addon)
        this.webGLAddon = addon
    }

    private onWebGLContextLoss (): void {
        this.webGLAddon?.dispose()
        this.webGLAddon = undefined
        this.pendingRendererRecovery = true
        this.recoverRenderer()
    }

    /**
     * Recreate the WebGL renderer after a lost GPU context. A new context can
     * only be created on a visible, focused canvas, so this no-ops while the
     * tab is hidden and is retried on reactivation or window focus.
     */
    private recoverRenderer (): void {
        if (!this.pendingRendererRecovery || !this.canRecoverRenderer()) {
            return
        }
        this.pendingRendererRecovery = false
        if (this.rendererRecoveryAttempts < MAX_WEBGL_RECOVERY_ATTEMPTS) {
            this.rendererRecoveryAttempts++
            this.attachWebGLAddon()
        }
        // Once the retry budget is exhausted xterm falls back to its DOM renderer.
        this.redraw()
    }

    private canRecoverRenderer (): boolean {
        return !!this.element && this.element.offsetParent !== null && document.hasFocus()
    }

    private redraw (): void {
        const renderService = this.xtermCore._renderService
        renderService?.clear()
        // handleResize() alone is a no-op when cols/rows are unchanged
        // resizeHandler() runs a real itAddon.fit() followed
        // by an unconditional viewport._refresh(),
        // forcing a full repaint
        this.resizeHandler()
        renderService?.handleResize(this.xterm.cols, this.xterm.rows)
    }

    private getSelectionAsHTML (): string {
        return this.serializeAddon.serializeAsHTML({ includeGlobalBackground: true, onlySelection: true  })
    }
}

/** @hidden */
export class XTermWebGLFrontend extends XTermFrontend {
    protected enableWebGL = true
}
