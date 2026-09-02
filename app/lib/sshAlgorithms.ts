import * as russh from 'russh'

// Mirrors tabby-ssh/src/api/interfaces.ts — the main process cannot import
// from plugin packages, so the algorithm type enum is duplicated here.
export enum SSHAlgorithmType {
    HMAC = 'hmac',
    KEX = 'kex',
    CIPHER = 'cipher',
    HOSTKEY = 'serverHostKey',
    COMPRESSION = 'compression',
}

export const supportedAlgorithms = {
    [SSHAlgorithmType.KEX]: russh.getSupportedKexAlgorithms().filter(x => x !== 'none'),
    [SSHAlgorithmType.HOSTKEY]: russh.getSupportedKeyTypes().filter(x => x !== 'none'),
    [SSHAlgorithmType.CIPHER]: russh.getSupportedCiphers().filter(x => x !== 'clear'),
    [SSHAlgorithmType.HMAC]: russh.getSupportedMACs().filter(x => x !== 'none'),
    [SSHAlgorithmType.COMPRESSION]: russh.getSupportedCompressionAlgorithms().reverse(),
}
