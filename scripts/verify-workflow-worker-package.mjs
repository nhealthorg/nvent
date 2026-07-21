import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTarget, TARGETS } from './workflow-worker-targets.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, '..')

function getArg(name) {
  const exact = process.argv.find((a) => a.startsWith(`${name}=`))
  if (exact) return exact.slice(name.length + 1)
  const idx = process.argv.indexOf(name)
  if (idx >= 0) return process.argv[idx + 1]
  return undefined
}

const targetKey = getArg('--target') || process.env.WORKFLOW_WORKER_TARGET
if (!targetKey) {
  throw new Error(`[workflow-worker] Missing --target. Expected one of: ${Object.keys(TARGETS).join(', ')}`)
}

const target = resolveTarget(targetKey)
const binPath = join(rootDir, target.packageDir, 'bin', target.binaryName)

if (!existsSync(binPath)) {
  throw new Error(`[workflow-worker] Missing binary for ${target.key}: ${binPath}. Run 'pnpm build:worker:package --target ${target.key}' first.`)
}

console.log(`[workflow-worker] Verified binary for ${target.key}: ${binPath}`)
