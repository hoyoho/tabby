import * as fs from 'mz/fs'

import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'tabby-core'

import { ShellProvider, Shell } from 'tabby-local'

/* eslint-disable block-scoped-var */

// WSL Distribution List
// https://docs.microsoft.com/en-us/windows/wsl/install-win10#install-your-linux-distribution-of-choice
/* eslint-disable quote-props */
const wslIconMap: Record<string, string> = {
    'Alpine': require('../icons/alpine.svg'),
    'Debian': require('../icons/debian.svg'),
    'kali-linux': require('../icons/kali.svg'),
    'SLES-12': require('../icons/suse.svg'),
    'openSUSE-Leap-15-1': require('../icons/suse.svg'),
    'Ubuntu-16.04': require('../icons/ubuntu.svg'),
    'Ubuntu-18.04': require('../icons/ubuntu.svg'),
    'Ubuntu-22.04': require('../icons/ubuntu.svg'),
    'Ubuntu': require('../icons/ubuntu.svg'),
    'AlmaLinux-8': require('../icons/alma.svg'),
    'OracleLinux_7_9': require('../icons/oracle-linux.svg'),
    'OracleLinux_8_5': require('../icons/oracle-linux.svg'),
    'openEuler': require('../icons/open-euler.svg'),
    'Linux': require('../icons/linux.svg'),
    'docker-desktop': require('../icons/docker.svg'),
    'docker-desktop-data': require('../icons/docker.svg'),
}
/* eslint-enable quote-props */

/** @hidden */
@Injectable()
export class WSLShellProvider extends ShellProvider {
    constructor (
        private hostApp: HostAppService,
    ) {
        super()
    }

    async provide (): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.Windows) {
            return []
        }

        // A single WSL template — distro-specific launches can be configured via
        // command arguments, so we never enumerate the installed distributions.
        const wslPath = `${process.env.windir}\\system32\\wsl.exe`
        const bashPath = `${process.env.windir}\\system32\\bash.exe`

        if (await fs.exists(wslPath)) {
            return [{
                id: 'wsl',
                name: 'WSL',
                command: wslPath,
                env: {
                    TERM: 'xterm-color',
                    COLORTERM: 'truecolor',
                },
                shellType: 'unix',
                icon: wslIconMap.Linux,
            }]
        }
        if (await fs.exists(bashPath)) {
            return [{
                id: 'wsl',
                name: 'WSL / Bash',
                command: bashPath,
                env: {
                    TERM: 'xterm-color',
                    COLORTERM: 'truecolor',
                },
                shellType: 'unix',
                icon: wslIconMap.Linux,
            }]
        }
        return []
    }
}
