/**
 * Wire protocol between the main process and the PTY host utility process
 * (`ptyHost.ts`).
 *
 * node-pty / ConPTY is native and has been observed to crash the process on
 * teardown when a child is still alive (WSL `sleep`, vim, a server). Running
 * it inside an Electron `utilityProcess` means such a crash only takes down
 * the host — the main process survives, marks the affected sessions dead and
 * can respawn the host. The main process therefore owns NO node-pty handle.
 */

/** Commands sent from the main process to the PTY host. */
export type PTYHostCommand =
    | { t: 'spawn', id: string, args: any[] }
    | { t: 'write', id: string, data: Uint8Array }
    | { t: 'resize', id: string, cols: number, rows: number }
    | { t: 'ack', id: string, length: number }
    | { t: 'kill', id: string, signal?: string }
    /** Watchdog liveness probe; the host answers with `pong`. */
    | { t: 'ping' }

/** Events reported by the PTY host back to the main process. */
export type PTYHostEvent =
    /** The PTY spawned; carries the OS pid once known. */
    | { t: 'spawned', id: string, pid: number }
    /** A node-pty event (`data` / `exit` / `close`), args forwarded verbatim. */
    | { t: 'event', id: string, event: string, args: any[] }
    /** Spawn failed. */
    | { t: 'error', id: string, message: string }
    /** Watchdog liveness answer. */
    | { t: 'pong' }
