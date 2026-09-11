/**
 * Contribute raw CSS that Tabby injects into the renderer document, in the
 * same global `<style id="custom-css">` that holds the user's own
 * "Custom CSS". Contributions from all providers are prepended before the
 * user's text, so hand-written rules always win.
 *
 * Scope your selectors: this stylesheet applies to the entire UI, not just
 * the terminal area.
 *
 * IMPORTANT: [[ThemesService]] instantiates every registered provider, so a
 * provider's constructor must not depend on [[ThemesService]] (that would be
 * a circular DI dependency). Inject it lazily, e.g. via `Injector.get()`, if
 * you need to trigger style re-application.
 */
export abstract class GlobalStyleProvider {
    /**
     * @return CSS rules to apply globally. Return an empty string (default)
     *         to contribute nothing.
     */
    provideStyles (): string {
        return ''
    }

    /**
     * Human-readable name of the module that provides these styles (e.g. the
     * package name). Falls back to the provider's class name when unset.
     * Used to attribute custom CSS variables in the settings UI.
     */
    getStyleModuleName (): string {
        return ''
    }
}