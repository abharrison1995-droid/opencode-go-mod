// Running opencode work by id, so the panel and /opencode cancel can stop it.
// A delegate job is tracked under its job id, a batch under `batch:<id>`.
const controllers = new Map<string, AbortController>()

export function track(id: string): AbortSignal {
  const c = new AbortController()
  controllers.set(id, c)
  return c.signal
}

export function untrack(id: string) {
  controllers.delete(id)
}

export function cancel(id: string): boolean {
  const c = controllers.get(id)
  if (c === undefined) return false
  c.abort()
  return true
}

export function tracked(): string[] {
  return [...controllers.keys()]
}
