import { BaseTabComponent } from '../components/baseTab.component'

/**
 * A tab that runs an actual connection (terminal / SSH / serial / telnet …).
 *
 * Domain invariant (enforced by AppService since R0):
 * a SessionTab MUST only live inside a WorkspaceComponent — it can never be a
 * top-level entry of `AppService.tabs`. Providers of sessions should extend
 * this class (via BaseTerminalTabComponent) so the guard can detect them.
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export abstract class SessionTab extends BaseTabComponent {
    /**
     * Broadcast (focus-all) mode support: called for every session of a
     * workspace while its foreground sessions share keyboard input. `true`
     * marks the session as participating (terminals force a blinking cursor
     * without taking real DOM focus), `false` clears the mark. No-op for
     * sessions without a terminal frontend.
     */
    setBroadcastFocus (_enabled: boolean): void { } // eslint-disable-line
}
