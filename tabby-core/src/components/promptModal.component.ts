import { Component, Input, ViewChild, ElementRef } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { TranslateService } from '@ngx-translate/core'

/** @hidden */
@Component({
    templateUrl: './promptModal.component.pug',
})
export class PromptModalComponent {
    @Input() value: string
    @Input() prompt: string|undefined
    @Input() password: boolean
    @Input() remember: boolean
    @Input() showRememberCheckbox: boolean
    @ViewChild('input') input: ElementRef

    get i18nRemember (): string {
        return this.translate.instant('Remember')
    }

    get i18nOK (): string {
        return this.translate.instant('OK')
    }

    constructor (
        private modalInstance: NgbActiveModal,
        private translate: TranslateService,
    ) { }

    ngOnInit (): void {
        setTimeout(() => {
            this.input.nativeElement.focus()
        })
    }

    ok (): void {
        this.modalInstance.close({
            value: this.value,
            remember: this.remember,
        })
    }

    cancel (): void {
        this.modalInstance.close(null)
    }
}
