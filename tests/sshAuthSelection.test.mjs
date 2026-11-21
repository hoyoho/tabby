import { test } from 'node:test'
import assert from 'node:assert/strict'

import { selectNextAuthMethod, updateAuthPlanAfterFailure } from '../app/lib/sshAuthSelection.ts'

const typeOf = method => method.type

test('selectNextAuthMethod takes the first method when the server allows anything', () => {
    const methods = [{ type: 'publickey' }, { type: 'password' }]
    assert.equal(selectNextAuthMethod(methods, [], typeOf), methods[0])
})

test('selectNextAuthMethod skips methods the server no longer allows', () => {
    const methods = [{ type: 'publickey' }, { type: 'password' }]
    assert.equal(selectNextAuthMethod(methods, ['password'], typeOf), methods[1])
    assert.equal(selectNextAuthMethod(methods, ['agent'], typeOf), undefined)
})

test('updateAuthPlanAfterFailure restores keyboard-interactive after a partial key success', () => {
    const plan = updateAuthPlanAfterFailure(
        [{ type: 'publickey' }],
        { partialSuccess: true, remainingMethods: ['publickey', 'keyboard-interactive'] },
        typeOf,
        authType => authType === 'keyboard-interactive' ? { type: 'keyboard-interactive' } : null,
    )
    assert.deepEqual(plan.remainingMethods, [{ type: 'publickey' }, { type: 'keyboard-interactive' }])
    assert.deepEqual(plan.allowedMethods, ['publickey', 'keyboard-interactive'])
})

test('updateAuthPlanAfterFailure does not invent methods after a plain failure', () => {
    const methods = [{ type: 'publickey' }]
    const plan = updateAuthPlanAfterFailure(
        methods,
        { remainingMethods: ['keyboard-interactive'] },
        typeOf,
        authType => authType === 'keyboard-interactive' ? { type: 'keyboard-interactive' } : null,
    )
    assert.deepEqual(plan.remainingMethods, methods)
    assert.deepEqual(plan.allowedMethods, ['keyboard-interactive'])
})
