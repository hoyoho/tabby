import { BaseTabComponent } from '../components/baseTab.component'

/**
 * A tab that appears in the top-level tab bar (`AppService.tabs`).
 *
 * Complement of [[SessionTab]]: top-level tabs are workspaces or whole-page
 * hosts (settings / release notes / welcome). Sessions can never be top-level.
 * Plugin components meant for the tab bar should extend this class.
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export abstract class TopLevelTab extends BaseTabComponent { }
