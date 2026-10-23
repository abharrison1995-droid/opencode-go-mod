// The test runner has the host's timers, which the engine's types leave out. Hooks code must not
// count on them (see timers() in delegate.ts); only tests call these.
declare function setTimeout(fn: (...args: unknown[]) => void, ms?: number): unknown
