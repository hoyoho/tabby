import * as keytar from 'keytar'
import { Injectable } from '@angular/core'
import { VaultService } from 'tabby-core'
import { SSHProfile } from '../api'

export const VAULT_SECRET_TYPE_PASSWORD = 'ssh:password'
export const VAULT_SECRET_TYPE_PASSPHRASE = 'ssh:key-passphrase'

/** Account name used in keytar for per-profile passwords. The password is
  * bound to the profile itself, so the username is not part of the key. */
const PROFILE_PASSWORD_ACCOUNT = 'default'

@Injectable({ providedIn: 'root' })
export class PasswordStorageService {
    constructor (private vault: VaultService) { }

    /** Store the password for a profile. Profiles without an id (e.g. quick
      * connect on the fly) have no dedicated storage and are ignored. */
    async savePassword (profile: SSHProfile, password: string, _username?: string): Promise<void> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForProfile(profile)
            if (!key) {
                return
            }
            this.vault.addSecret({ type: VAULT_SECRET_TYPE_PASSWORD, key, value: password })
        } else {
            const key = this.getKeytarKeyForProfile(profile)
            if (!key) {
                return
            }
            return keytar.setPassword(key, PROFILE_PASSWORD_ACCOUNT, password)
        }
    }

    async deletePassword (profile: SSHProfile, _username?: string): Promise<void> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForProfile(profile)
            if (!key) {
                return
            }
            this.vault.removeSecret(VAULT_SECRET_TYPE_PASSWORD, key)
        } else {
            const key = this.getKeytarKeyForProfile(profile)
            if (!key) {
                return
            }
            await keytar.deletePassword(key, PROFILE_PASSWORD_ACCOUNT)
        }
    }

    async loadPassword (profile: SSHProfile, _username?: string): Promise<string|null> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForProfile(profile)
            if (!key) {
                return null
            }
            const secret = await this.vault.getSecret(VAULT_SECRET_TYPE_PASSWORD, key)
            return secret ? secret.value : null
        } else {
            const key = this.getKeytarKeyForProfile(profile)
            if (!key) {
                return null
            }
            try {
                return await keytar.getPassword(key, PROFILE_PASSWORD_ACCOUNT)
            } catch (e) {
                console.warn(`Failed to load stored password for profile ${profile.name}`, e)
                return null
            }
        }
    }

    async savePrivateKeyPassword (id: string, password: string): Promise<void> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            this.vault.addSecret({ type: VAULT_SECRET_TYPE_PASSPHRASE, key, value: password })
        } else {
            const key = this.getKeytarKeyForPrivateKey(id)
            return keytar.setPassword(key, 'user', password)
        }
    }

    async deletePrivateKeyPassword (id: string): Promise<void> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            this.vault.removeSecret(VAULT_SECRET_TYPE_PASSPHRASE, key)
        } else {
            const key = this.getKeytarKeyForPrivateKey(id)
            await keytar.deletePassword(key, 'user')
        }
    }

    async loadPrivateKeyPassword (id: string): Promise<string|null> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            return (await this.vault.getSecret(VAULT_SECRET_TYPE_PASSPHRASE, key))?.value ?? null
        } else {
            const key = this.getKeytarKeyForPrivateKey(id)
            return keytar.getPassword(key, 'user')
        }
    }

    private getKeytarKeyForProfile (profile: SSHProfile): string|null {
        return profile.id ? `ssh-profile:${profile.id}` : null
    }

    private getKeytarKeyForPrivateKey (id: string): string {
        return `ssh-private-key:${id}`
    }

    private getVaultKeyForProfile (profile: SSHProfile) {
        return profile.id ? { profileId: profile.id } : null
    }

    private getVaultKeyForPrivateKey (id: string) {
        return { hash: id }
    }
}
