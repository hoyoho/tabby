export interface PasteNormalizationOptions {
    /** Clipboard line endings follow Windows conventions (\r\n). */
    windows: boolean
    replaceNewlinesWithSpaces: boolean
    trimWhitespaceOnPaste: boolean
}

/**
 * Converts clipboard text into the line endings and whitespace shape the
 * terminal expects. Pure so the rules can be tested without a DOM or a
 * platform service.
 */
export function normalizePastedText (text: string, options: PasteNormalizationOptions): string {
    let data = options.windows ? text.replaceAll('\r\n', '\r') : text.replaceAll('\n', '\r')

    if (options.replaceNewlinesWithSpaces) {
        data = data.replace(/[\r\n]+/g, ' ')
    }

    if (options.trimWhitespaceOnPaste && data.indexOf('\n') === data.length - 1) {
        // Ends with a newline and has no other line breaks.
        data = data.substring(0, data.length - 1)
    }

    return data
}

/**
 * Final whitespace trim for a single-line paste (applied only when the
 * multi-line warning is skipped). A paste that still contains a CR keeps its
 * leading whitespace, matching shell heredoc-style input.
 */
export function trimPastedText (data: string): string {
    data = data.trimEnd()
    if (!data.includes('\r')) {
        data = data.trimStart()
    }
    return data
}
