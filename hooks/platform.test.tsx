import { expect, test } from 'claude-code/testing'

import { findOpencode } from './catalog'
import { resolveDir } from './delegate'
import { findAgy } from './gemini'
import { homeOf, posixArgv, shArgv } from './platform'

const plain = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

const WINDOWS: Record<string, string> = {
  OS: 'Windows_NT',
  USERPROFILE: 'C:\\Users\\me',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
}

// A host with the given environment, files, and `where` answers (no sh on PATH).
function fakeEngine(o: { env: Record<string, string>; files?: string[]; where?: Record<string, string> }) {
  const ran: string[][] = []
  const $: any = {
    env: { get: async (name: string) => o.env[name] },
    fs: { stat: async (path: string) => ((o.files ?? []).includes(path) ? { size: 1 } : Promise.reject(new Error('missing'))) },
    process: {
      run: async (argv: string[]) => {
        ran.push([...argv])
        const hit = argv[0] === 'where.exe' ? o.where?.[argv[1]!] : undefined
        return hit === undefined ? plain('', 1) : plain(hit)
      },
    },
  }
  return { $, ran }
}

const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm'
const OPENCODE = `${NPM}/node_modules/opencode-ai/bin/opencode.exe`
const GIT_SH = 'C:\\Program Files\\Git/bin/sh.exe'

test("Windows finds the opencode.exe behind npm's shim, never the .cmd", async () => {
  const { $, ran } = fakeEngine({ env: WINDOWS, files: [OPENCODE], where: { opencode: `${NPM}\\opencode\r\n${NPM}\\opencode.cmd\r\n` } })
  expect(await findOpencode($)).toBe(OPENCODE)
  expect(ran.some(argv => argv[0] === 'sh')).toBe(false)
})

test('Windows finds agy.exe where its installer puts it', async () => {
  const installed = 'C:\\Users\\me\\AppData\\Local/agy/bin/agy.exe'
  const { $ } = fakeEngine({ env: WINDOWS, files: [installed] })
  expect(await findAgy($)).toBe(installed)
})

test('Windows takes agy.exe from PATH first', async () => {
  const onPath = 'D:\\tools\\agy.exe'
  const { $ } = fakeEngine({ env: WINDOWS, files: [onPath], where: { agy: `${onPath}\r\n` } })
  expect(await findAgy($)).toBe(onPath)
})

test('Windows has no agy without the installer', async () => {
  const { $ } = fakeEngine({ env: WINDOWS })
  expect(await findAgy($)).toBeUndefined()
})

test('Windows home is USERPROFILE', async () => {
  const { $ } = fakeEngine({ env: { ...WINDOWS, HOME: '/c/Users/me' } })
  expect(await homeOf($)).toBe('C:\\Users\\me')
})

test("Windows runs shell scripts and POSIX tools through Git for Windows' sh", async () => {
  const { $ } = fakeEngine({ env: WINDOWS, files: [GIT_SH], where: { git: 'C:\\Program Files\\Git\\cmd\\git.exe\r\n' } })
  expect(await shArgv($, 'npm test')).toEqual([GIT_SH, '-c', 'npm test'])
  expect(await posixArgv($, ['rm', '-f', 'C:\\x.log'])).toEqual([GIT_SH, '-c', '"$0" "$@"', 'rm', '-f', 'C:\\x.log'])
})

test('Windows without Git for Windows has no sh', async () => {
  const { $ } = fakeEngine({ env: WINDOWS })
  expect(await shArgv($, 'npm test')).toBeUndefined()
  expect(await posixArgv($, ['rm', '-f', 'x'])).toEqual(['rm', '-f', 'x'])
})

test('elsewhere the argv is unchanged', async () => {
  const { $, ran } = fakeEngine({ env: { HOME: '/home/test' } })
  expect(await shArgv($, 'npm test')).toEqual(['sh', '-c', 'npm test'])
  expect(await posixArgv($, ['mkdir', '-p', '/a'])).toEqual(['mkdir', '-p', '/a'])
  expect(await homeOf($)).toBe('/home/test')
  expect(ran).toEqual([])
})

test('resolveDir keeps Windows drive paths absolute', async () => {
  expect(resolveDir('C:\\proj', 'sub')).toBe('C:/proj/sub')
  expect(resolveDir('C:\\proj', 'D:\\other\\x\\..\\y')).toBe('D:/other/y')
  expect(resolveDir('/proj', '../a')).toBe('/a')
  expect(resolveDir('', 'a/../../b')).toBe('../b')
})
