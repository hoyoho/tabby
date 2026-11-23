import deepEqual from 'deep-equal'
import { filter, fromEvent, takeUntil } from 'rxjs'
import { Injector } from '@angular/core'
import { ConfigService, getCSSFontFamily, getWindows10Build, HostAppService, HotkeysService, isWindowsBuild, Platform, PlatformService, TerminalColorScheme, ThemesService, WIN_BUILD_BUNDLED_CONPTY_SUPPORTED, WIN_BUILD_CONPTY_REFLOW_SUPPORTED } from 'tabby-core'
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
import { buildXtermTheme } from './xtermTheme'
import { FlowControl } from './flowControl'
import { disposeWebglAddon } from './webglAddon'
import './xterm.css'

// How many times to recreate the WebGL renderer after a lost GPU context
// before giving up and letting xterm fall back to its DOM renderer.
const MAX_WEBGL_RECOVERY_ATTEMPTS = 3

// Fcitx5 applies Chinese punctuation during the browser's default text-input
// processing. If xterm handles these keys on keydown, it calls preventDefault()
// before Fcitx5 can emit the converted keypress/input event.
const LINUX_IME_TEXT_KEY_CODES = new Set([
    'Backquote',
    'Backslash',
    'BracketLeft',
    'BracketRight',
    'Comma',
    'Period',
    'Quote',
    'Semicolon',
    'Slash',
])

function isIMETextKey (event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.altKey || event.metaKey) {
        return false
    }
    return LINUX_IME_TEXT_KEY_CODES.has(event.code) || event.code === 'Space' && event.shiftKey
}

/** @hidden */
export class XTermFrontend extends Frontend {
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
    /** Animation frame id of the scrollbar-drag pin-state loop, if running. */
    private scrollbarDragFrame?: number
    /** Whether a scrollbar drag is currently being tracked. */
    private scrollbarDragging = false
    /** Stops the current scrollbar drag tracking and removes its window listeners. */
    private stopScrollbarDrag?: () => void
    /** The xterm 6 vertical scrollbar element, once the terminal is opened. */
    private scrollbarElement?: HTMLElement

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
            overviewRuler: {
                width: 7,
                showBottomBorder: false,
                showTopBorder: false,
            },
            reflowCursorLine: true,
            windowsPty: process.platform === 'win32' ? {
                // node-pty has no winpty backend: Windows sessions are always
                // ConPTY, and `useBundledConPTY` only selects between the bundled
                // DLL and the system one — a distinction xterm does not model.
                backend: 'conpty',
                buildNumber: this.configService.store.terminal.useBundledConPTY && isWindowsBuild(WIN_BUILD_BUNDLED_CONPTY_SUPPORTED)
                    ? WIN_BUILD_CONPTY_REFLOW_SUPPORTED
                    : getWindows10Build(),
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

            const handled = keyboardEventHandler(event.type, event)
            if (!handled) {
                // a hotkey claimed the event and already cancelled it
                return false
            }

            if (event.type === 'keydown' && this.hostApp.platform === Platform.Linux && isIMETextKey(event)) {
                // Returning false keeps xterm from sending/cancelling keydown.
                // The resulting keypress/input event contains either the IME
                // commit string or the original character when IME is inactive.
                return false
            }

            return handled
        })

        this.xtermCore._scrollToBottom = this.xtermCore.scrollToBottom.bind(this.xtermCore)
        this.xtermCore.scrollToBottom = () => null

        // NOTE: xterm.onScroll only fires for content-driven scroll (new lines),
        // NOT for user wheel/keyboard scroll (xterm.js #3864, #3201). During
        // fast output, viewportY transiently equals baseY during xterm's
        // internal processing, so onScroll would falsely re-pin. We do NOT
        // use onScroll for pin state. Pin state is updated only via:
        //   - wheel/keyboard event listeners (below)
        //   - the scrollbar drag loop (below)
        //   - explicit scrollToBottom() calls

        const doResize = () => {
            try {
                if (this.xterm.element && getComputedStyle(this.xterm.element).getPropertyValue('height') !== 'auto') {
                    const savedPinned = this.pinnedToBottom
                    const savedViewportY = this.xterm.buffer.active.viewportY

                    this.fitAddon.fit()
                    this.xterm.refresh(0, this.xterm.rows - 1)

                    if (savedPinned) {
                        this.xtermCore._scrollToBottom()
                    } else {
                        // Restore the previous scroll position after fit
                        const maxScroll = this.xterm.buffer.active.baseY
                        const targetY = Math.min(savedViewportY, maxScroll)
                        this.xterm.scrollToLine(targetY)
                    }
                    this.updateScrollbarVisibility()

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
            this.updateScrollbarVisibility()
        })

        // xterm's own scrollbar fades out while idle; keep our own
        // "has scrollback" class in sync with content changes.
        this.xterm.onScroll(() => this.updateScrollbarVisibility())
    }

    private isAtBottom (): boolean {
        const buffer = this.xterm.buffer.active
        return buffer.viewportY >= buffer.baseY - 1
    }

    private updatePinnedState (): void {
        this.pinnedToBottom = this.isAtBottom()
    }

    /**
     * xterm fades its own scrollbar to `.invisible` after a short idle period,
     * and the `.fade` class can outlive the scrollback (for example after a
     * clear). Put the visibility class on the `.xterm` root instead of the
     * scrollbar element itself: xterm rewrites the scrollbar's className when
     * it reveals/hides it, but only adds/removes individual root classes.
     */
    private updateScrollbarVisibility (): void {
        const hasScrollback = this.xterm.buffer.active.baseY > 0
        this.xterm.element?.classList.toggle('tabby-has-scrollback', hasScrollback)
    }

    private onScrollbarPress = (e: MouseEvent): void => {
        // xterm's own handler on `.xterm` starts a new selection and would
        // wipe the current one. The scrollbar is a real DOM node inside
        // `.xterm`, so stop the event before it bubbles up; this keeps the
        // search addon's "last match" selection intact across scrollbar drags.
        e.stopPropagation()
        // The user grabbed the scrollbar, so the next search navigation should
        // re-anchor to the viewport instead of continuing from the last match.
        this.userScrolledSinceLastSearch = true

        if (this.scrollbarDragging) {
            return
        }
        this.scrollbarDragging = true
        const update = () => {
            this.updatePinnedState()
            this.scrollbarDragFrame = requestAnimationFrame(update)
        }
        const stop = () => {
            this.scrollbarDragging = false
            this.stopScrollbarDrag = undefined
            if (this.scrollbarDragFrame !== undefined) {
                cancelAnimationFrame(this.scrollbarDragFrame)
                this.scrollbarDragFrame = undefined
            }
            window.removeEventListener('mouseup', stop)
            window.removeEventListener('blur', stop)
            // Capture the position after the final pointer move, which may have
            // happened after the last animation frame.
            this.updatePinnedState()
        }
        this.stopScrollbarDrag = stop
        window.addEventListener('mouseup', stop)
        window.addEventListener('blur', stop)
        this.updatePinnedState()
        update()
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

        // User-initiated scroll detection: wheel, keyboard and scrollbar input
        // should unpin. xterm.onScroll is content-driven only and must never
        // unpin (see constructor comment). Use capture phase — xterm.js
        // handles wheel/key events on its internal scrollable element and may
        // stop propagation, so bubbling listeners on host would never fire.
        this.addHostListener('wheel', (event: WheelEvent) => {
            // Immediately unpin on scroll-up so that writes arriving before
            // the next animation frame don't yank the viewport back down.
            if (event.deltaY < 0) {
                this.pinnedToBottom = false
            }
            requestAnimationFrame(() => this.updatePinnedState())
        }, { capture: true, passive: true })

        // xterm 6 replaced the native viewport scrollbar with an internal
        // ScrollableElement, so `.xterm-viewport` no longer scrolls and its DOM
        // `scroll` event never fires. Scrollbar drags (thumb or track) emit
        // neither wheel nor keyboard events, so follow the real vertical
        // scrollbar and re-evaluate the pin state on every animation frame
        // while the user holds it. Otherwise arriving output would yank the
        // viewport back to the bottom mid-drag.
        const scrollbar = this.xterm.element?.querySelector('.xterm-scrollable-element > .scrollbar.vertical') as HTMLElement | null
        this.scrollbarElement = scrollbar ?? undefined
        this.updateScrollbarVisibility()
        if (scrollbar) {
            // Remove handlers left over from a previous attach() that did not
            // detach cleanly, then wire the shared press handler.
            scrollbar.removeEventListener('pointerdown', this.onScrollbarPress)
            scrollbar.removeEventListener('mousedown', this.onScrollbarPress)
            // xterm 6 starts scrollbar drags from `pointerdown` and cancels it,
            // which suppresses the compatibility `mousedown` in Chromium.
            // Listen to both so tracking starts reliably everywhere; the
            // explicit `scrollbarDragging` guard prevents a duplicate start.
            scrollbar.addEventListener('pointerdown', this.onScrollbarPress)
            scrollbar.addEventListener('mousedown', this.onScrollbarPress)
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

        this.addHostListener('dragover', (event: any) => this.dragOver.next(event))
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
        this.stopScrollbarDrag?.()
        if (this.scrollbarDragFrame !== undefined) {
            cancelAnimationFrame(this.scrollbarDragFrame)
            this.scrollbarDragFrame = undefined
        }
        this.scrollbarDragging = false
        if (this.scrollbarElement) {
            this.scrollbarElement.removeEventListener('pointerdown', this.onScrollbarPress)
            this.scrollbarElement.removeEventListener('mousedown', this.onScrollbarPress)
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
        disposeWebglAddon(this.webGLAddon)
        this.canvasAddon?.dispose()
        this.xterm.dispose()
        this.scrollbarElement = undefined
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
        setTimeout(() => {
            // Don't steal focus from modal dialogs (e.g. the SSH password prompt)
            // or the tab's own overlay inputs - the deferred focus from a window
            // focus event would otherwise land right after the user clicks into one
            const active = document.activeElement
            const tabHost = this.element?.parentElement
            if (
                active instanceof HTMLElement
                && active !== this.xterm.textarea
                && active.matches('input, textarea, select')
                && ((tabHost?.contains(active) ?? false) || active.closest('ngb-modal-window') !== null)
            ) {
                return
            }
            this.xterm.focus()
        })
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
        // pinnedToBottom is kept in sync by the wheel/keyboard handlers and the
        // scrollbar drag loop, so re-evaluate it AFTER the await: a search/wheel
        // that scrolled the viewport away from the bottom during the write must
        // not be undone by a stale wasPinned=true.
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
        this.updateScrollbarVisibility()
    }

    clear (): void {
        this.xterm.clear()
        this.updateScrollbarVisibility()
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
        const theme = buildXtermTheme({ scheme, background })

        const terminalConfig = this.configService.store.terminal
        if (terminalConfig.paletteGenerate) {
            theme.extendedAnsi = generatePalette(
                scheme.colors,
                scheme.background,
                scheme.foreground,
                terminalConfig.paletteHarmonious,
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
            if (this.xterm.cols && this.xterm.rows && this.xtermCore._charSizeService) {
                this.xtermCore._charSizeService.measure()
                this.xtermCore._renderService.handleResize(this.xterm.cols, this.xterm.rows)
                this.resizeHandler()
            }
        })

        this.xtermCore.browser = {
            ...this.xtermCore.browser,
            isWindows: this.hostApp.platform === Platform.Windows,
            isLinux: this.hostApp.platform === Platform.Linux,
            isMac: this.hostApp.platform === Platform.macOS,
        }

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
        // xterm keeps the mouse encoding, cursor visibility and scroll margins
        // off its public API; read them through the internal core with
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
     * absent: xterm does not implement it, so no kitty state exists here
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
        disposeWebglAddon(this.webGLAddon)
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
        // handleResize() alone is a no-op when cols/rows are unchanged.
        // resizeHandler() runs a real fitAddon.fit() followed by an
        // unconditional xterm.refresh(...), forcing a full repaint.
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
