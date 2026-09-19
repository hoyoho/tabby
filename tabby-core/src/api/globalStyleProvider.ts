/**
 * Contribute raw CSS that Tabby injects into the renderer document, in the
 * same global `<style id="custom-css">` that holds the user's own
 * "Custom CSS". Contributions from all providers are prepended before the
 * user's text, so hand-written rules always win.
 *
 * Scope your selectors: this stylesheet applies to the entire UI, not just
 * the terminal area.
 *
 * Background ownership: `body` is the window's single background layer
 * (`--body-bg`, faded by core while vibrancy is on), and `tab-body` /
 * `split-tab` are deliberately transparent. A provider that supplies its own
 * background must paint it *above* that layer — e.g. a negative-z-index
 * pseudo-element — and report it via [[wantsCustomBackground]]. Do not
 * re-paint `tab-body` / `split-tab`: those layers stack on top of `body` and
 * their alphas multiply, which drowns out the OS vibrancy.
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

    /**
     * When true, this provider paints the window's own background (an image,
     * a wallpaper, ...) and core gets out of its way:
     *  - the terminal surface is kept transparent, so the provider's
     *    background shows through instead of the theme's terminal colour;
     *  - `body` gains the `custom-background` class, which lets core's own
     *    full-window backgrounds (e.g. the start page) stand aside.
     *
     * Return true only while that background is actually active.
     */
    wantsCustomBackground (): boolean {
        return false
    }
}