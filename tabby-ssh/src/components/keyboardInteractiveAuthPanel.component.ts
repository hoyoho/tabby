import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, HostListener, ChangeDetectionStrategy } from '@angular/core'
import { PlatformService } from 'tabby-core'
import { KeyboardInteractivePrompt } from '../session/ssh'
import { SSHProfile } from '../api'

const PROMPT_URL_REGEX = /https?:\/\/[^\s<>"']+/g
const TRAILING_PROMPT_URL_PUNCTUATION = /[),.;:!?]+$/

interface PromptPart {
    text: string
    url?: string
}

@Component({
    selector: 'keyboard-interactive-auth-panel',
    templateUrl: './keyboardInteractiveAuthPanel.component.pug',
    styleUrls: ['./keyboardInteractiveAuthPanel.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyboardInteractiveAuthComponent {
    @Input() profile: SSHProfile
    @Input() prompt: KeyboardInteractivePrompt
    @Input() step = 0
    @Output() done = new EventEmitter()
    @Output() cancelled = new EventEmitter()
    @ViewChild('input') input: ElementRef
    private settled = false

    constructor (
        private platform: PlatformService,
    ) {}

    isPassword (): boolean {
        return this.prompt.isAPasswordPrompt(this.step)
    }

    shouldEcho (): boolean {
        return this.prompt.prompts[this.step].echo ?? false
    }

    getPromptParts (): PromptPart[] {
        return this.parsePromptText(this.prompt.prompts[this.step].prompt)
    }

    parsePromptText (text: string): PromptPart[] {
        const parts: PromptPart[] = []
        let lastIndex = 0

        for (const match of text.matchAll(PROMPT_URL_REGEX)) {
            const matchedText = match[0]
            const matchIndex = match.index ?? 0
            const punctuationMatch = TRAILING_PROMPT_URL_PUNCTUATION.exec(matchedText)
            const trailingPunctuation = punctuationMatch?.[0] ?? ''
            const url = trailingPunctuation ? matchedText.slice(0, -trailingPunctuation.length) : matchedText

            if (matchIndex > lastIndex) {
                parts.push({ text: text.slice(lastIndex, matchIndex) })
            }

            if (this.isPromptUrl(url)) {
                parts.push({ text: url, url })
                if (trailingPunctuation) {
                    parts.push({ text: trailingPunctuation })
                }
            } else {
                parts.push({ text: matchedText })
            }

            lastIndex = matchIndex + matchedText.length
        }

        if (lastIndex < text.length) {
            parts.push({ text: text.slice(lastIndex) })
        }

        return parts.length ? parts : [{ text }]
    }

    openPromptLink (url: string|undefined, event: Event): void {
        event.preventDefault()

        if (url) {
            this.platform.openExternal(url)
        }
    }

    previous (): void {
        if (this.step > 0) {
            this.step--
        }
        this.input.nativeElement.focus()
    }

    next (): void {
        if (this.step === this.prompt.prompts.length - 1) {
            this.settled = true
            this.prompt.respond()
            this.done.emit()
            return
        }
        this.step++
        this.input.nativeElement.focus()
    }

    /** ESC cancels the whole k-i exchange — the answers are discarded. */
    @HostListener('document:keydown.escape')
    cancel (): void {
        if (this.settled) {
            return
        }
        this.settled = true
        this.prompt.reject()
        this.cancelled.emit()
    }

    private isPromptUrl (url: string): boolean {
        try {
            const parsedUrl = new URL(url)
            return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:'
        } catch {
            return false
        }
    }
}
