import { Component, Input, Output, EventEmitter, OnDestroy } from '@angular/core'

/** @hidden */
@Component({
    selector: 'color-picker',
    templateUrl: './colorPicker.component.pug',
    styleUrls: ['./colorPicker.component.scss'],
})
export class ColorPickerComponent implements OnDestroy {
    @Input() model: string
    @Input() title: string
    @Input() hint: string
    @Output() modelChange = new EventEmitter<string>()

    // The ngx-colors panel is created dynamically by a third-party service and
    // its PanelComponent is not part of the public API, so we cannot patch its
    // prototype directly. Instead we observe the DOM for the panel's input and
    // keep its text colour in sync with the typed value while it is open.
    private domObserver: MutationObserver
    private rafId: number | null = null
    private panelOpen = false
    // Cached probe element used to normalise colour strings into rgb() form
    // without touching the live DOM every frame.
    private colorProbe: HTMLDivElement

    constructor () {
        this.setupColorInputSync()
    }

    ngOnDestroy (): void {
        this.domObserver.disconnect()
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId)
        }
    }

    private setupColorInputSync (): void {
        // Detect the ngx-colors panel being attached/removed to start/stop
        // the lightweight polling loop that keeps the input text coloured.
        this.domObserver = new MutationObserver(() => {
            const input = this.findPanelInput()
            const isOpen = !!input
            if (isOpen && !this.panelOpen) {
                this.panelOpen = true
                this.startPolling()
            } else if (!isOpen && this.panelOpen) {
                this.panelOpen = false
                this.stopPolling()
            }
        })
        this.domObserver.observe(document.body, { childList: true, subtree: true })
    }

    private startPolling (): void {
        const tick = () => {
            const input = this.findPanelInput()
            if (input) {
                this.applyInputColor(input)
            }
            this.rafId = requestAnimationFrame(tick)
        }
        this.rafId = requestAnimationFrame(tick)
    }

    private stopPolling (): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId)
            this.rafId = null
        }
    }

    private findPanelInput (): HTMLInputElement | null {
        return document.querySelector('ngx-colors-panel .g-input input')
    }

    private applyInputColor (input: HTMLInputElement): void {
        const value = input.value
        const rgb = this.parseColor(value)
        if (rgb) {
            // The background fills with the typed colour so the user sees the
            // actual swatch; the text uses the opposite luminance (black on
            // bright, white on dark) to guarantee legibility.
            const luminance = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b
            const contrast = luminance > 140 ? '#000000' : '#ffffff'
            input.style.backgroundColor = value
            input.style.color = contrast
            input.style.caretColor = contrast
        } else {
            // Invalid / incomplete input: restore a neutral white background
            // with dark text so the typed characters stay readable.
            input.style.backgroundColor = '#ffffff'
            input.style.color = '#1e1e1e'
            input.style.caretColor = '#1e1e1e'
        }
    }

    /**
     * Normalise a colour string (hex, rgb/a, hsl/a, named, ...) into its RGB
     * components. Returns null when the string is not a recognised CSS colour.
     * The browser normalises the value via the style setter, so we can parse
     * the resulting rgb(...) / rgba(...) representation without appending to
     * the live DOM.
     */
    private parseColor (value: string): { r: number; g: number; b: number } | null {
        if (!value) {
            return null
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!this.colorProbe) {
            this.colorProbe = document.createElement('div')
        }
        const style = this.colorProbe.style
        style.color = ''
        style.color = value
        if (!style.color) {
            return null
        }
        const parts = style.color.match(/\d+/g)
        if (!parts || parts.length < 3) {
            return null
        }
        return { r: +parts[0], g: +parts[1], b: +parts[2] }
    }
}
