// In-process nudge for the background worker: scheduling an async job calls kickWorker(), and the worker (index.ts) runs a
// pass straight away instead of waiting for its next tick. Without a listener (api-only role, tests) it is a no-op and the
// job simply waits for a worker tick — durability never depends on the kick.
let listener: (() => void) | undefined;
export const onKick = (fn: (() => void) | undefined): void => { listener = fn; };
export const kickWorker = (): void => { try { listener?.(); } catch { /* a kick is only a hint */ } };

/** node types that may run in the background ("Is Async"): the ones that do work; events, gateways and waits have nothing to defer */
export const ASYNC_CAPABLE: ReadonlySet<string> = new Set(['script', 'http', 'workItem', 'rule', 'send', 'call', 'forEach', 'subprocess']);
