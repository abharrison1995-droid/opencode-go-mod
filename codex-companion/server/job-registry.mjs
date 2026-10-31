const TERMINAL = new Set(['completed','failed','cancelled'])

export function makeRoomForJob(jobs, maximum) {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error('Job limit must be a positive integer.')
  if (jobs.size >= maximum) {
    const oldestTerminal = [...jobs.values()].find(job => TERMINAL.has(job.status))
    if (oldestTerminal) jobs.delete(oldestTerminal.id)
  }
  if (jobs.size >= maximum) throw new Error(`The bridge is at its ${maximum}-job concurrency limit.`)
}
