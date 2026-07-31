import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { resolveTarget } from './workflow-worker-targets.mjs'

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

const inputTarget = getArg('--target') || process.env.WORKFLOW_WORKER_TARGET
const target = resolveTarget(inputTarget)

const cargoArgs = [
  'build',
  '--manifest-path',
  join('workers', 'workflow', 'Cargo.toml'),
  '--release',
  '--target',
  target.triple,
]

console.log(`[workflow-worker] Building target ${target.key} (${target.triple})`)
const build = spawnSync('cargo', cargoArgs, {
  cwd: rootDir,
  stdio: 'inherit',
  env: process.env,
})

if (build.status !== 0) {
  process.exit(build.status || 1)
}

const builtBinary = join(rootDir, 'workers', 'workflow', 'target', target.triple, 'release', target.binaryName)
if (!existsSync(builtBinary)) {
  throw new Error(`[workflow-worker] Built binary not found at ${builtBinary}`)
}

const destBinDir = join(rootDir, target.packageDir, 'bin')
mkdirSync(destBinDir, { recursive: true })
const destBinary = join(destBinDir, target.binaryName)
const tempBinary = join(destBinDir, `${target.binaryName}.tmp-${process.pid}-${Date.now()}`)

try {
  // Copy to a fresh temp path first, then atomically replace the destination.
  // This avoids ETXTBSY when the old destination binary is currently executing.
  copyFileSync(builtBinary, tempBinary)
  if (process.platform !== 'win32') {
    chmodSync(tempBinary, 0o755)
  }
  renameSync(tempBinary, destBinary)
}
finally {
  // Best-effort cleanup when copy/rename fails before replacement.
  rmSync(tempBinary, { force: true })
}

console.log(`[workflow-worker] Copied binary to ${destBinary}`)
