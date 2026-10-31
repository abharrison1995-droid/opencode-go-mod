import { getUsage, sanitizeDiagnostic } from './usage.mjs'

const args = process.argv.slice(2)
if (args[0] !== 'usage') {
  process.stderr.write('Usage: node usage-cli.mjs usage [--directory PATH] [--force]\n')
  process.exitCode = 2
} else {
  let directory = process.cwd()
  let force = false
  for (let index = 1; index < args.length; index++) {
    if (args[index] === '--directory') directory = args[++index] ?? directory
    else if (args[index] === '--force') force = true
  }
  try {
    const usage = await getUsage({ directory, force })
    process.stdout.write(JSON.stringify({ usage }) + '\n')
  } catch (error) {
    process.stderr.write(sanitizeDiagnostic(error instanceof Error ? error.message : error) + '\n')
    process.exitCode = 1
  }
}
