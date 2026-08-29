import { Injectable } from '@angular/core'

import { Logger, LogService, UpdaterService } from 'tabby-core'

/**
 * Auto-update support has been removed from this build: never check GitHub,
 * never talk to electron-updater. `check()` just reports "no update".
 */
@Injectable()
export class ElectronUpdaterService extends UpdaterService {
    private logger: Logger

    constructor (
        log: LogService,
    ) {
        super()
        this.logger = log.create('updater')
    }

    async check (): Promise<boolean> {
        this.logger.debug('Updates are disabled')
        return false
    }

    async update (): Promise<void> {
        this.logger.debug('Updates are disabled')
    }
}
