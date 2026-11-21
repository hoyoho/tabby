import { Spinner } from 'cli-spinner'

export interface TerminalSpinnerHost {
    /** Whether the terminal frontend is ready to receive spinner frames. */
    canWrite: () => boolean
    /** Writes a raw spinner frame, bypassing the normal output pipeline. */
    write: (data: string) => void
    /** Runs the spinner timer outside Angular's change detection. */
    runOutsideAngular: <T>(work: () => T) => T
}

/**
 * Owns the CLI spinner shown while a new session starts. Extracted from
 * `BaseTerminalTabComponent` so its pause/resume state machine stays separate
 * from terminal input and lifecycle handling.
 */
export class TerminalSpinner {
    private spinner: Spinner
    private active = false
    private paused = false

    constructor (private host: TerminalSpinnerHost) {
        this.spinner = new Spinner({
            stream: {
                write: x => {
                    try {
                        if (!this.host.canWrite()) {
                            return
                        }
                        this.host.write(x)
                    } catch {
                        this.spinner.stop()
                    }
                },
            },
        })
    }

    start (text?: string): void {
        if (this.active || this.paused) {
            return
        }
        if (text) {
            this.spinner.text = text
        }
        this.spinner.setSpinnerString(6)
        this.active = true
        this.host.runOutsideAngular(() => {
            this.spinner.start()
        })
    }

    stop (): void {
        if (!this.active) {
            return
        }
        this.spinner.stop(true)
        this.active = false
    }

    /**
     * Runs `work` with the spinner temporarily hidden, then restores it if it
     * was active before. Used around writes so spinner frames don't interleave
     * with session output.
     */
    async withPaused (work: () => any): Promise<void> {
        this.paused = true
        if (this.active) {
            this.spinner.stop(true)
        }
        try {
            await work()
        } finally {
            this.paused = false
            if (this.active) {
                this.host.runOutsideAngular(() => {
                    this.spinner.start()
                })
            }
        }
    }
}
