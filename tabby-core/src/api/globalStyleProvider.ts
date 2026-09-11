/**
 * Contribute raw CSS that Tabby injects into the renderer document, in the
 * same global `<style id="custom-css">` that holds the user's own
 * "Custom CSS". Contributions from all providers are prepended before the
 * user's text, so hand-written rules always win.
 *
 * Scope your selectors: this stylesheet applies to the entire UI, not just
 * the terminal area.
 */
export abstract class GlobalStyleProvider {
    /**
     * @return CSS rules to apply globally. Return an empty string (default)
     *         to contribute nothing.
     */
    provideStyles (): string {
        return ''
    }
}