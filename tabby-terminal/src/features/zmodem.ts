import colors from 'ansi-colors'
import * as ZModem from 'zmodem.js'
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Observable, filter, first } from 'rxjs'
import { EnvironmentInjector, inject, Injectable } from '@angular/core'
import { TerminalDecorator } from '../api/decorator'
import { BaseTerminalTabComponent } from '../api/baseTerminalTab.component'
import { SessionMiddleware } from '../api/middleware'
import { BaseSession } from '../session'
import { DirectoryUpload, FileUpload, LogService, Logger, NotificationsService, PlatformService, TranslateService } from 'tabby-core'

const SPACER = '            '
/** How long to wait for the remote `rz` to emit its ZMODEM header. */
const UPLOAD_START_TIMEOUT = 10_000
/**
 * Bytes the sender may queue before waiting for the transport to accept them.
 * Small enough that SFTP requests on the same SSH connection never wait long,
 * large enough to keep a high-latency link busy.
 */
const UPLOAD_WINDOW = 256 * 1024
/**
 * How long an upload may sit without the transport accepting data, or without
 * the peer answering a protocol handshake. ZMODEM's sender is a firehose with
 * no per-packet acknowledgements, so silence is the only signal that a
 * transfer has died.
 */
const TRANSFER_STALL_TIMEOUT = 30_000

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
    })
    // When the timeout wins the original may still reject later; that rejection
    // is meaningless by then but must not surface as unhandled.
    promise.catch(() => undefined)
    return Promise.race([promise, timeout]).finally(() => {
        clearTimeout(timer)
    })
}

class ZModemMiddleware extends SessionMiddleware {
    private sentry: ZModem.Sentry
    private isActive = false
    private logger: Logger
    private activeSession: any = null
    private cancelEvent: Observable<any>

    // While non-null, terminal output is buffered here instead of being sent
    // straight to the terminal. Used to hold back a receive session's trailing
    // bytes (the shell prompt redrawn after sz exits) until after the final
    // "Received"/"Complete" messages have been printed, so the prompt is not
    // overwritten by showMessage()'s leading "\r".
    private trailingBuffer: Buffer[] | null = null

    /**
     * Files a local drag-and-drop asked to upload. Set before `rz` is typed
     * into the shell, consumed by the next ZMODEM detection. This is what
     * lets the drop bypass the usual "Accept a ZMODEM session?" prompt and the
     * native file picker.
     */
    private pendingUpload: FileUpload[] | null = null
    private pendingUploadTimer: ReturnType<typeof setTimeout> | null = null

    private flushTrailingBuffer () {
        const buffered = this.trailingBuffer
        this.trailingBuffer = null
        if (!buffered?.length) {
            return
        }
        for (const chunk of buffered) {
            this.outputToTerminal.next(chunk)
        }
    }

    /**
     * Starts an upload the user requested by dropping files onto the terminal.
     *
     * Types `rz` into the shell and holds the files until the remote receiver
     * announces itself. The terminal-side caller already rejects full-screen
     * programs, where `rz` would be delivered to the foreground app instead of
     * a shell.
     */
    queueUpload (uploads: FileUpload[]): void {
        if (!uploads.length) {
            return
        }
        if (this.pendingUpload ?? this.activeSession ?? this.isActive) {
            this.notifications.notice(this.translate.instant(_('A ZMODEM upload is already in progress')))
            for (const upload of uploads) {
                upload.cancel()
            }
            return
        }

        this.pendingUpload = uploads
        this.pendingUploadTimer = setTimeout(
            () => this.cancelPendingUpload(),
            UPLOAD_START_TIMEOUT,
        )

        this.showMessage(colors.bgBlue.black(' ZMODEM ') + ` Sending ${uploads.length} file(s) with rz`)
        // Kill a half-typed command first. Both readline and the canonical TTY
        // driver treat ^U as kill-line, so dropping onto a shell cannot turn
        // "cd /tmp" into "cd /tmprz". `-y` makes an existing remote file get
        // overwritten instead of skipped, which is what a drop implies.
        this.outputToSession.next(Buffer.from('\x15rz -y\r'))
    }

    /** Consumes the drop request that a detection just answered. */
    private takePendingUpload (): FileUpload[] | null {
        if (this.pendingUploadTimer) {
            clearTimeout(this.pendingUploadTimer)
            this.pendingUploadTimer = null
        }
        const uploads = this.pendingUpload
        this.pendingUpload = null
        return uploads
    }

    private cancelPendingUpload (): void {
        if (!this.pendingUpload) {
            return
        }
        if (this.pendingUploadTimer) {
            clearTimeout(this.pendingUploadTimer)
            this.pendingUploadTimer = null
        }
        const uploads = this.pendingUpload
        this.pendingUpload = null
        // The remote shell already reports its own `rz: command not found`, so
        // keep this out of the terminal and surface it as a toast instead. By
        // the time it fires the user may be running something else.
        this.logger.warn('rz did not start before the upload timeout; is lrzsz installed on the remote host?')
        this.notifications.error(this.translate.instant(_('ZMODEM upload did not start. Is lrzsz installed on the remote host?')))
        for (const upload of uploads) {
            upload.cancel()
        }
    }

    close (): void {
        if (this.pendingUploadTimer) {
            clearTimeout(this.pendingUploadTimer)
            this.pendingUploadTimer = null
        }
        for (const upload of this.pendingUpload ?? []) {
            upload.cancel()
        }
        this.pendingUpload = null
        super.close()
    }

    private log = inject(LogService)
    private translate = inject(TranslateService)
    private platform = inject(PlatformService)
    private notifications = inject(NotificationsService)

    constructor (private session: BaseSession) {
        super()
        this.cancelEvent = this.outputToSession$.pipe(filter(x => x.length === 1 && x[0] === 3))

        this.logger = this.log.create('zmodem')
        this.sentry = new ZModem.Sentry({
            // to_terminal is zmodem.js' single terminal-output channel. It
            // receives normal passthrough data (while no session is active),
            // protocol "garbage", and crucially the trailing bytes that follow
            // a session's "OO" terminator (e.g. the shell prompt redrawn after
            // sz/rz exits). These trailing bytes are emitted synchronously from
            // within the same consume() call that fires session_end, so any
            // guard based on isActive/activeSession would drop them on platforms
            // where "OO" and the prompt arrive in the same chunk (Linux).
            // While trailingBuffer is active they are queued so the final
            // status messages can be printed first; otherwise forward directly.
            to_terminal: data => {
                if (this.trailingBuffer) {
                    this.trailingBuffer.push(Buffer.from(data))
                } else {
                    this.outputToTerminal.next(Buffer.from(data))
                }
            },
            sender: data => this.outputToSession.next(Buffer.from(data)),
            on_detect: async detection => {
                // A local drag-and-drop initiated this transfer: the user
                // already asked for it, so skip both the security prompt and
                // the native file picker.
                const uploads = this.takePendingUpload()

                if (!uploads && (await this.platform.showMessageBox({
                    type: 'warning',
                    message: this.translate.instant('Accept a ZMODEM session?'),
                    detail: this.translate.instant('If you have not requested it, it could be a sign of malicious activity.'),
                    buttons: [
                        this.translate.instant('Accept'),
                        this.translate.instant('Reject'),
                    ],
                    defaultId: 0,
                    cancelId: 1,
                })).response === 1) {
                    // Accept the detection to get a session, then immediately
                    // abort so that proper ZABORT frames are sent to the remote
                    // side, causing the remote rz/sz process to terminate.
                    try {
                        const zsession = detection.confirm()
                        zsession.abort()
                    } catch { }
                    // Clean up terminal output after rejection
                    this.showMessage(colors.bgRed.black(' Rejected ') + ' ZMODEM session')
                    return
                }

                try {
                    this.isActive = true
                    await this.process(detection, uploads ?? undefined)
                } finally {
                    this.isActive = false
                }
            },
            on_retract: () => {
                // The remote never completed a handshake the drop asked for.
                for (const upload of this.takePendingUpload() ?? []) {
                    upload.cancel()
                }
                this.showMessage('transfer cancelled')
                this.activeSession = null
                this.isActive = false
            },
        })
    }

    feedFromSession (data: Buffer): void {
        if (this.isActive || this.activeSession) {
            try {
                this.sentry.consume(data)
            } catch (e) {
                this.showMessage(colors.bgRed.black(' Error ') + ' ' + e)
                this.logger.error('protocol error', e)
                this.activeSession?.abort()
                this.activeSession = null
                this.isActive = false
                // Don't forward the problematic data to terminal
                return
            }
        } else {
            // No active session: sentry.consume() routes everything straight
            // back through to_terminal, so we must not output here as well or
            // the data would be duplicated. Only on a consume() failure do we
            // forward the raw data as a fallback so nothing is lost.
            try {
                this.sentry.consume(data)
            } catch (e) {
                this.logger.error('zmodem detection error', e)
                this.outputToTerminal.next(data)
            }
        }
    }

    private async process (detection, uploads?: FileUpload[]): Promise<void> {
        this.showMessage(colors.bgBlue.black(' ZMODEM ') + ' Session started')
        this.showMessage('------------------------')

        const zsession = detection.confirm()
        this.activeSession = zsession
        this.logger.info('new session', zsession)

        try {
            if (zsession.type === 'send') {
                // Dragged files win over the native picker; both paths end up
                // in the same sender loop below.
                const transfers = uploads ?? await this.platform.startUpload({ multiple: true })
                let filesRemaining = transfers.length
                let sizeRemaining = transfers.reduce((a, b) => a + b.getSize(), 0)
                let completed = true
                for (let i = 0; i < transfers.length; i++) {
                    const transfer = transfers[i]
                    completed = await this.sendFile(zsession, transfer, filesRemaining, sizeRemaining)
                    filesRemaining--
                    sizeRemaining -= transfer.getSize()
                    if (!completed) {
                        // The user cancelled: release the files that were
                        // queued behind the one being sent.
                        for (const remaining of transfers.slice(i + 1)) {
                            remaining.cancel()
                        }
                        break
                    }
                }
                if (completed) {
                    await withTimeout(
                        zsession.close(),
                        TRANSFER_STALL_TIMEOUT,
                        'the remote did not confirm the end of the session',
                    )
                    this.showMessage(colors.bgBlue.black(' ZMODEM ') + ' Complete')
                }
            } else {
                // A drop asked for an upload, but the remote started a receive
                // session instead. Its files cannot ride on this transfer, so
                // release their streams rather than leaving them pending.
                for (const upload of uploads ?? []) {
                    upload.cancel()
                }
                const pendingReceives: Promise<void>[] = []
                zsession.on('offer', xfer => {
                    pendingReceives.push(this.receiveFile(xfer, zsession))
                })

                // session_end fires synchronously inside sentry.consume(),
                // immediately before the session's trailing bytes (the shell
                // prompt redrawn after sz exits) are flushed via to_terminal.
                // Start buffering here so those bytes are held back until after
                // all "Received" messages and the "Complete" message have been
                // printed; otherwise the prompt would be emitted first and then
                // overwritten by showMessage()'s leading "\r".
                zsession.on('session_end', () => {
                    this.trailingBuffer = []
                })

                zsession.start()

                await new Promise(resolve => zsession.on('session_end', resolve))
                await Promise.all(pendingReceives)

                this.showMessage(colors.bgBlue.black(' ZMODEM ') + ' Complete')
                this.flushTrailingBuffer()
            }
        } catch (error) {
            this.logger.error('ZMODEM session error', error)
            this.showMessage(colors.bgRed.black(' ZMODEM ') + ` Session failed: ${error.message}`)
            try {
                zsession.abort()
            } catch { }
        } finally {
            this.activeSession = null

            // Safety net: if an error left bytes buffered (e.g. session_end
            // started buffering but the flush above was skipped), release them
            // so terminal output is never permanently swallowed.
            if (this.trailingBuffer) {
                this.flushTrailingBuffer()
            }
        }
    }

    private async receiveFile (xfer, zsession) {
        const details: {
            name: string,
            size: number,
        } = xfer.get_details()
        this.showMessage(colors.bgYellow.black(' Offered ') + ' ' + details.name, true)
        this.logger.info('offered', xfer)

        const transfer = await this.platform.startDownload(details.name, 0o644, details.size)
        if (!transfer) {
            this.showMessage(colors.bgRed.black(' Rejected ') + ' ' + details.name)
            xfer.skip()
            return
        }

        let canceled = false
        const cancelSubscription = this.cancelEvent.subscribe(() => {
            try {
                zsession._skip()
            } catch {}
            canceled = true
        })

        let writeQueue: Promise<void> = Promise.resolve()
        let receivedBytes = 0
        let lastUpdateTime = 0

        try {
            await Promise.race([
                xfer.accept({
                    on_input: chunk => {
                        if (canceled) {
                            return
                        }

                        receivedBytes += chunk.length
                        const now = Date.now()
                        if (now - lastUpdateTime > 500) {
                            lastUpdateTime = now
                            const percent = Math.round(100 * receivedBytes / details.size)
                            const percentStr = percent.toString().padStart(3, ' ')
                            this.showMessage(colors.bgYellow.black(` ${percentStr}% `) + ' ' + details.name, true)
                        }

                        writeQueue = writeQueue
                            .then(() => transfer.write(Buffer.from(chunk)))
                            .catch(err => {
                                this.logger.error('Zmodem write error', err)
                            })
                    },
                }),
                this.cancelEvent.pipe(first()).toPromise(),
            ])

            await writeQueue

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (canceled) {
                transfer.cancel()
                this.showMessage(colors.bgRed.black(' Canceled ') + ' ' + details.name)
            } else {
                transfer.close()
                this.showMessage(colors.bgGreen.black(' Received ') + ' ' + details.name)
            }
        } catch {
            this.showMessage(colors.bgRed.black(' Error ') + ' ' + details.name)
        }

        cancelSubscription.unsubscribe()
    }

    /**
     * Sends one file. Returns false when the user cancelled, in which case the
     * session has already been aborted and must not be closed as if complete.
     */
    private async sendFile (zsession, transfer: FileUpload, filesRemaining, sizeRemaining): Promise<boolean> {
        const offer = {
            name: transfer.getName(),
            size: transfer.getSize(),
            mode: transfer.getMode(),
            files_remaining: filesRemaining,
            bytes_remaining: sizeRemaining,
        }
        this.logger.info('offering', offer)
        this.showMessage(colors.bgYellow.black(' Offered ') + ' ' + offer.name, true)

        const xfer = await zsession.send_offer(offer)
        if (!xfer) {
            transfer.cancel()
            this.showMessage(colors.bgRed.black(' Rejected ') + ' ' + offer.name)
            this.logger.warn('rejected by the other side')
            return true
        }

        let canceled = false
        const cancelSubscription = this.cancelEvent.subscribe(() => {
            canceled = true
            // ^C is also on its way to the remote, but the local firehose would
            // keep queueing file bytes until rz reacts. Abort locally so the
            // sender stops and the connection is released immediately.
            try {
                zsession.abort()
            } catch { }
        })

        try {
            let unflushed = 0
            while (!canceled) {
                const chunk = await transfer.read()
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (canceled || !chunk.length) {
                    break
                }

                // ZMODEM's send() is synchronous and the receiver never
                // acknowledges file data (CANOVIO), so pacing has to come from
                // the transport. Waiting once per window keeps the SSH
                // connection's write queue short, which is what lets the SFTP
                // channel sharing that connection stay responsive.
                xfer.send(chunk)
                unflushed += chunk.length
                if (unflushed >= UPLOAD_WINDOW) {
                    await this.waitForUploadProgress()
                    unflushed = 0
                }

                this.showMessage(colors.bgYellow.black(' ' + Math.round(100 * transfer.getCompletedBytes() / offer.size).toString().padStart(3, ' ') + '% ') + offer.name, true)
            }

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (canceled) {
                transfer.cancel()
                this.showMessage(colors.bgRed.black(' Canceled ') + ' ' + offer.name)
                return false
            }

            transfer.close()

            // end() writes the last subpacket and ZEOF synchronously, then
            // resolves once the receiver answers; a receiver that stops reading
            // leaves it pending forever, which is the only failure signal
            // ZMODEM offers.
            await withTimeout(
                xfer.end(),
                TRANSFER_STALL_TIMEOUT,
                'rz stopped acknowledging the end of the file',
            )

            this.showMessage(colors.bgGreen.black(' Sent ') + ' ' + offer.name)
            return true
        } finally {
            cancelSubscription.unsubscribe()
        }
    }

    /**
     * Waits for the transport to accept everything written so far, and bounds
     * how long that may take. A receiver that stops reading (or a wedged
     * connection) leaves the channel silent, which is the only failure signal
     * ZMODEM offers.
     */
    private async waitForUploadProgress (): Promise<void> {
        await withTimeout(
            this.session.drainOutput(),
            TRANSFER_STALL_TIMEOUT,
            'the connection stopped accepting data',
        )
    }

    private showMessage (msg: string, overwrite = false) {
        this.outputToTerminal.next(Buffer.from(`\r${msg}${SPACER}`))
        if (!overwrite) {
            this.outputToTerminal.next(Buffer.from('\r\n'))
        }
    }
}

/**
 * Flattens a drag-and-drop tree into the flat file list a ZMODEM sender can
 * offer. Directories keep no structure: rz writes every file into the remote
 * working directory.
 */
function collectFileUploads (root: DirectoryUpload): FileUpload[] {
    const files: FileUpload[] = []
    const walk = (entry: FileUpload|DirectoryUpload) => {
        if (entry instanceof DirectoryUpload) {
            for (const child of entry.getChildrens()) {
                walk(child)
            }
        } else {
            files.push(entry)
        }
    }
    for (const child of root.getChildrens()) {
        walk(child)
    }
    return files
}

/** @hidden */
@Injectable()
export class ZModemDecorator extends TerminalDecorator {
    #injector = inject(EnvironmentInjector)
    private platform = inject(PlatformService)
    private notifications = inject(NotificationsService)
    private translate = inject(TranslateService)
    private middlewares = new Map<BaseTerminalTabComponent<any>, ZModemMiddleware>()

    attach (terminal: BaseTerminalTabComponent<any>): void {
        setTimeout(() => {
            // The tab may have been destroyed between attach() and this timer;
            // adding subscriptions then would leave them registered forever.
            const frontend = terminal.frontend
            if (!frontend) {
                return
            }
            this.attachToSession(terminal)
            this.subscribeUntilDetached(terminal, terminal.sessionChanged$.subscribe(() => {
                this.attachToSession(terminal)
            }))

            this.subscribeUntilDetached(terminal, frontend.dragOver$.subscribe(event => this.onDragOver(event)))
            this.subscribeUntilDetached(terminal, frontend.drop$.subscribe(event => {
                void this.onDrop(terminal, event)
            }))
        })
    }

    detach (terminal: BaseTerminalTabComponent<any>): void {
        this.middlewares.delete(terminal)
        super.detach(terminal)
    }

    private attachToSession (terminal: BaseTerminalTabComponent<any>) {
        const session = terminal.session
        if (!session) {
            return
        }
        const middleware = this.#injector.runInContext(() => new ZModemMiddleware(session))
        this.middlewares.set(terminal, middleware)
        session.middleware.unshift(middleware)
    }

    private onDragOver (event: DragEvent): void {
        const dataTransfer = event.dataTransfer
        // Internal tab/workspace drags carry their own MIME type, not 'Files'.
        if (!dataTransfer?.types.includes('Files')) {
            return
        }
        event.preventDefault()
        dataTransfer.dropEffect = 'copy'
    }

    private async onDrop (terminal: BaseTerminalTabComponent<any>, event: DragEvent): Promise<void> {
        const dataTransfer = event.dataTransfer
        if (!dataTransfer?.files.length) {
            return
        }

        // Plain drops keep pasting the quoted path (PathDropDecorator in
        // tabby-electron). Ctrl+drop is the opt-in ZMODEM upload gesture, so
        // the two decorators never act on the same drop.
        if (!event.ctrlKey) {
            return
        }

        event.preventDefault()
        event.stopPropagation()

        if (!terminal.session?.open) {
            return
        }
        // Reachable only for Ctrl+drop: a plain drop returned above and is
        // pasted as a path by PathDropDecorator, even in a full-screen program.
        if (terminal.alternateScreenActive) {
            this.notifications.error(this.translate.instant(_('Cannot send files while a full-screen program is running')))
            return
        }

        // Called synchronously before the first await: DataTransfer contents are
        // only valid for the duration of the drop event.
        const tree = await this.platform.startUploadFromDragEvent(event, true)
        const uploads = collectFileUploads(tree)
        if (!uploads.length) {
            return
        }
        this.middlewares.get(terminal)?.queueUpload(uploads)
    }
}
