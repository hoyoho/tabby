import { Component, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { TranslateService } from '@ngx-translate/core'
import { NotificationsService, VaultFileSecret } from 'tabby-core'

/** @hidden */
@Component({
    templateUrl: './showSecretModal.component.pug',
})
export class ShowSecretModalComponent {
    @Input() title: string
    @Input() secret: VaultFileSecret

    constructor (
        public modalInstance: NgbActiveModal,
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) { }

    close (): void {
        this.modalInstance.dismiss()
    }

    copySecret (): void {
        navigator.clipboard.writeText(this.secret.value)
        // Show a notification
        this.notifications.info(this.translate.instant('Copied to clipboard'))
    }
}
