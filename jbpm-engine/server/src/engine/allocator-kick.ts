// Same idea as async-kick.ts: a task waiting for the allocator was just created in this process, so run a pass now instead of waiting for the next interval.
let listener: (() => void) | undefined;
export const onAllocatorKick = (fn: (() => void) | undefined): void => { listener = fn; };
export const kickAllocator = (): void => { try { listener?.(); } catch { /* a kick is only a hint */ } };
