import * as os from 'os'
import { Subject, Observable } from 'rxjs'
import { SessionMiddleware } from '../api/middleware'

const OSCPrefix = Buffer.from('\x1b]')
const OSCSuffixes = [Buffer.from('\x07'), Buffer.from('\x1b\\')]

export class OSCProcessor extends SessionMiddleware {
    get cwdReported$ (): Observable<string> { return this.cwdReported }
    get copyRequested$ (): Observable<string> { return this.copyRequested }
    get titleCWDReported$ (): Observable<string> { return this.titleCWDReported }

    private cwdReported = new Subject<string>()
    private buffer: Buffer | null = null
    private copyRequested = new Subject<string>()
    private titleCWDReported = new Subject<string>()

    feedFromSession (data: Buffer): void {
        // Prepend any buffered data from previous chunks
        if (this.buffer) {
            data = Buffer.concat([this.buffer, data])
            this.buffer = null
        }

        let startIndex = 0
        const processedData: Buffer[] = []

        while (startIndex < data.length) {
            const prefixIndex = data.indexOf(OSCPrefix, startIndex)

            if (prefixIndex === -1) {
                // No more OSC sequences, pass remaining data
                if (startIndex < data.length) {
                    processedData.push(data.subarray(startIndex))
                }
                break
            }

            // Pass data before this OSC sequence
            if (prefixIndex > startIndex) {
                processedData.push(data.subarray(startIndex, prefixIndex))
            }

            // Look for suffix after the prefix
            const suffixSearchStart = prefixIndex + OSCPrefix.length
            let foundSuffix: [Buffer, number] | null = null

            for (const suffix of OSCSuffixes) {
                const suffixIndex = data.indexOf(suffix, suffixSearchStart)
                if (suffixIndex !== -1) {
                    if (!foundSuffix || suffixIndex < foundSuffix[1]) {
                        foundSuffix = [suffix, suffixIndex]
                    }
                }
            }

            if (!foundSuffix) {
                // No suffix found - buffer the rest and wait for next chunk
                this.buffer = data.subarray(prefixIndex)
                break
            }

            // Extract OSC string (between prefix and suffix)
            const oscString = data.subarray(suffixSearchStart, foundSuffix[1]).toString()
            const [oscCodeString, ...oscParams] = oscString.split(';')
            const oscCode = parseInt(oscCodeString)

            if (oscCode === 1337) {
                const paramString = oscParams.join(';')
                if (paramString.startsWith('CurrentDir=')) {
                    let reportedCWD = paramString.split('=', 2)[1]
                    if (reportedCWD.startsWith('~')) {
                        reportedCWD = os.homedir() + reportedCWD.substring(1)
                    }
                    this.cwdReported.next(reportedCWD)
                } else {
                    console.debug('Unsupported OSC 1337 parameter:', paramString)
                }
            } else if (oscCode === 52) {
                if (oscParams[0] === 'c' || oscParams[0] === '') {
                    const content = Buffer.from(oscParams[1], 'base64')
                    this.copyRequested.next(content.toString())
                }
            } else if (oscCode === 0 || oscCode === 2) {
                // OSC 0/2 = window title. bash packages the current directory
                // into its PS1 title (`\e]0;\u@\h: \w\a`), so use it as a
                // fallback CWD source for shells that don't emit OSC 1337.
                const title = oscParams.join(';')
                const cwd = this.extractCWDFromTitle(title)
                if (cwd) {
                    this.titleCWDReported.next(cwd)
                }
                processedData.push(data.subarray(prefixIndex, foundSuffix[1] + foundSuffix[0].length))
            } else {
                processedData.push(data.subarray(prefixIndex, foundSuffix[1] + foundSuffix[0].length))
            }

            // Move past this OSC sequence
            startIndex = foundSuffix[1] + foundSuffix[0].length
        }

        // Pass through all processed data
        if (processedData.length > 0) {
            super.feedFromSession(Buffer.concat(processedData))
        }
    }

    /**
     * Extract a working directory from a shell-provided window title.
     *
     * Common formats:
     * - `user@host: /home/user`        (Ubuntu/Debian default `\u@\h: \w`)
     * - `user@host: ~/foo`             (same, but home-relative)
     * - `/home/user`                   (title set to bare `pwd`)
     * - `MINGW64:/c/Users/me`          (Git Bash)
     *
     * Anything that doesn't look like a path is rejected (e.g. window titles,
     * program names), so non-bash shells like cmd/PowerShell fall through to
     * the existing Windows CWD guessing untouched.
     */
    private extractCWDFromTitle (title: string): string|null {
        const stripped = title.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim()
        if (!stripped) {
            return null
        }
        // `user@host: path` — take everything after the first `: ` that follows
        // a single `@` host segment (avoid matching `C:` inside Windows paths).
        const hostPath = /^\s*[\w.+-]+@[\w.+-]+\s*:\s*(.+)/.exec(stripped)
        if (hostPath) {
            return hostPath[1] || null
        }
        // Bare Unix-style path (leading `/` or `~/`).
        if (/^(~|~\/|\/)/.test(stripped)) {
            return stripped
        }
        // Git Bash: `MINGW64:/c/...`
        const mingw = /^\s*[\w.+-]+\s*:\s*(\/.*)/.exec(stripped)
        if (mingw) {
            return mingw[1] || null
        }
        return null
    }

    close (): void {
        this.cwdReported.complete()
        this.copyRequested.complete()
        this.titleCWDReported.complete()
        super.close()
    }
}
