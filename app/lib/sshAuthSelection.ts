export interface AuthenticationFailure {
    partialSuccess?: boolean
    remainingMethods: string[]
}

export interface AuthenticationPlan<T> {
    remainingMethods: T[]
    allowedMethods: string[]
}

/**
 * Pick the next authentication method the server will accept.
 *
 * An empty `allowedMethods` means the server did not restrict the list.
 */
export function selectNextAuthMethod<T> (
    remainingMethods: readonly T[],
    allowedMethods: readonly string[],
    getAuthType: (method: T) => string,
): T|undefined {
    if (!allowedMethods.length) {
        return remainingMethods[0]
    }
    return remainingMethods.find(method => allowedMethods.includes(getAuthType(method)))
}

/**
 * Update the auth plan after a failed attempt.
 *
 * A partial success can advertise a method the initial plan never contained
 * (most notably keyboard-interactive after a key was accepted), so add a
 * fallback for every advertised method that is missing from the plan.
 */
export function updateAuthPlanAfterFailure<T> (
    remainingMethods: readonly T[],
    failure: AuthenticationFailure,
    getAuthType: (method: T) => string,
    createPartialSuccessFallback: (authType: string) => T|null,
): AuthenticationPlan<T> {
    const updatedRemainingMethods = [...remainingMethods]
    const updatedAllowedMethods = [...failure.remainingMethods]

    if (failure.partialSuccess) {
        for (const authType of updatedAllowedMethods) {
            if (!updatedRemainingMethods.some(method => getAuthType(method) === authType)) {
                const fallback = createPartialSuccessFallback(authType)
                if (fallback) {
                    updatedRemainingMethods.push(fallback)
                }
            }
        }
    }

    return {
        remainingMethods: updatedRemainingMethods,
        allowedMethods: updatedAllowedMethods,
    }
}
