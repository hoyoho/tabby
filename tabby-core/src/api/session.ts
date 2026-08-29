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
export abstract class SessionTab extends BaseTabComponent { }
