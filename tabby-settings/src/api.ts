/**
 * Extend to add your own settings tabs
 */
export abstract class SettingsTabProvider {
    id: string
    icon: string
    title: string
    weight = 0
    prioritized = false
    /**
     * Where the tab is rendered: 'top' shows it as a top level settings
     * section, any other value nests it into the matching named section
     * (e.g. 'profiles-advanced' renders inside the profiles settings tab).
     */
    section = 'top'

    getComponentType (): any {
        return null
    }
}
