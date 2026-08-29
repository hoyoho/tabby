/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Input, HostBinding, ElementRef, Output, EventEmitter } from '@angular/core'
import { SelfPositioningComponent } from './selfPositioning.component'
import { SplitContainer, minSizeOf, SPLITTER_BAND } from './workspace.component'

/**
 * Draggable gutter between two panes.
 *
 * The drag is a visual-preview gesture: while the pointer is down only the
 * splitter's own element follows the mouse (clamped to each side's minimum
 * size), and the actual ratio change is committed on mouseup in a single
 * `change` event, so every pane resizes in one full relayout after release.
 */
/** @hidden */
@Component({
    selector: 'split-tab-spanner',
    template: '',
    styleUrls: ['./splitTabSpanner.component.scss'],
})
export class SplitTabSpannerComponent extends SelfPositioningComponent {
    @Input() container: SplitContainer
    @Input() index: number
    @Input() x: number
    @Input() y: number
    @Input() w: number
    @Input() h: number
    @Output() resizing = new EventEmitter<boolean>()
    @Output() change = new EventEmitter<void>()
    @HostBinding('class.active') isActive = false
    @HostBinding('class.h') isHorizontal = false
    @HostBinding('class.v') isVertical = true

    private get el (): HTMLElement {
        return this.element.nativeElement
    }

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (element: ElementRef) {
        super(element)
    }

    ngAfterViewInit () {
        this.el.addEventListener('dblclick', () => {
            this.reset()
        })

        this.el.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0) return

            const c = this.container
            const vertical = c.orientation === 'v'
            const axis: 'w'|'h' = vertical ? 'h' : 'w'
            const totalPx = c.axisPx
            if (!totalPx) return

            this.isActive = true
            this.resizing.emit(true)

            const rA = c.ratios[this.index - 1] ?? 1
            const rB = c.ratios[this.index] ?? 1
            const totalRatio = rA + rB
            // Recompute from the pixel sizes produced by the last layout, not
            // axisPx*ratio, so the drag always maps 1:1 onto the rendered cells.
            const before = c.children[this.index - 1]
            const after = c.children[this.index]
            const n = c.children.length
            const usable = Math.max(totalPx - (n > 1 ? (n - 1) * SPLITTER_BAND : 0), 0)
            const before0 = c.pixelSizes[this.index - 1] ?? usable * rA
            const after0 = c.pixelSizes[this.index] ?? usable * rB
            const minBefore = Math.min(minSizeOf(before, axis), before0)
            const minAfter = Math.min(minSizeOf(after, axis), after0)
            const start = vertical ? e.pageY : e.pageX
            const startPos = vertical ? this.el.offsetTop : this.el.offsetLeft

            // Pixel offset of the bar along its axis, clamped to the legal
            // range so the preview can never cross a minimum-sized pane.
            const clampedOffset = (event: MouseEvent): number => {
                const delta = (vertical ? event.pageY : event.pageX) - start
                return Math.max(minBefore, Math.min(before0 + delta, before0 + after0 - minAfter)) - before0
            }

            // While the pointer is down only the bar follows the mouse; the
            // ratios stay untouched so every pane keeps its size until release.
            const dragHandler = (event: MouseEvent): void => {
                const offset = clampedOffset(event)
                if (vertical) {
                    this.el.style.top = `${startPos + offset}px`
                } else {
                    this.el.style.left = `${startPos + offset}px`
                }
            }

            // Commit the whole drag in one go on release: update the two
            // adjacent ratios and let the parent run a single full relayout.
            const cleanup = (event: MouseEvent): void => {
                this.isActive = false
                this.resizing.emit(false)
                document.removeEventListener('mouseup', cleanup)
                document.removeEventListener('mousemove', dragHandler)

                const offset = clampedOffset(event)
                if (Math.abs(offset) >= 1) {
                    const newBefore = before0 + offset
                    c.ratios[this.index - 1] = (newBefore / (before0 + after0)) * totalRatio
                    c.ratios[this.index] = totalRatio - c.ratios[this.index - 1]
                }
                this.change.emit()
            }

            document.addEventListener('mouseup', cleanup, { passive: true })
            document.addEventListener('mousemove', dragHandler, { passive: true })
        }, { passive: true })
    }

    ngOnChanges () {
        this.isHorizontal = this.container.orientation === 'h'
        this.isVertical = this.container.orientation === 'v'
        this.setDimensions(this.x, this.y, this.w, this.h, 'px')
    }

    reset () {
        const a = this.container.ratios[this.index - 1]
        const b = this.container.ratios[this.index]
        this.container.ratios[this.index - 1] = (a + b) / 2
        this.container.ratios[this.index] = (a + b) / 2
        this.change.emit()
    }
}
