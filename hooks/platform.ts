import type { EngineInterface } from 'claude-code'

// Windows has no sh, rm or mkdir on PATH and often no HOME, and a spawn runs no shell, so it
// cannot start npm's .cmd shims either. Everywhere else these give the argv the mod always ran.

export async function isWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

export async function homeOf($: EngineInterface): Promise<string | undefined> {
  if (await isWindows($)) return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return $.env.get('HOME')
}

export const isExe = (path: string) => /\.exe$/i.test(path)

export const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '')

export const isAbsolute = (path: string) => /^([A-Za-z]:)?[\\/]/.test(path)

// Every match for `name` on PATH: `command -v`'s one, or each of `where`'s on Windows.
export async function whereAll($: EngineInterface, name: string): Promise<string[]> {
  const argv = (await isWindows($)) ? ['where.exe', name] : ['sh', '-c', `command -v ${name}`]
  const found = await $.process.run(argv).catch(() => undefined)
  if (found === undefined || found.exitCode !== 0) return []
  return found.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
}

// Git for Windows ships sh.exe (and the POSIX tools it finds) two folders above git.exe.
async function gitSh($: EngineInterface): Promise<string | undefined> {
  const direct = (await whereAll($, 'sh')).find(isExe)
  if (direct !== undefined) return direct
  for (const git of await whereAll($, 'git')) {
    const root = dirOf(dirOf(git))
    for (const sh of [`${root}/bin/sh.exe`, `${root}/usr/bin/sh.exe`]) {
      if ((await $.fs.stat(sh).catch(() => undefined)) !== undefined) return sh
    }
  }
  return undefined
}

/** Runs `script` in a POSIX shell; undefined on Windows without Git for Windows. */
export async function shArgv($: EngineInterface, script: string): Promise<string[] | undefined> {
  if (!(await isWindows($))) return ['sh', '-c', script]
  const sh = await gitSh($)
  return sh === undefined ? undefined : [sh, '-c', script]
}

/** Runs a POSIX tool (mkdir, cp, rm) by its argv: itself, or on Windows through Git's sh. */
export async function posixArgv($: EngineInterface, argv: string[]): Promise<string[]> {
  if (!(await isWindows($))) return argv
  const sh = await gitSh($)
  return sh === undefined ? argv : [sh, '-c', '"$0" "$@"', ...argv]
}
