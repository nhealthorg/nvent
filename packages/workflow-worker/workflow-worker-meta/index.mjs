import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const TARGET_MAP = {
  'linux-x64': '@nvent-addon/workflow-worker-linux-x64-gnu',
  'linux-arm64': '@nvent-addon/workflow-worker-linux-arm64-gnu',
  'darwin-x64': '@nvent-addon/workflow-worker-darwin-x64',
  'darwin-arm64': '@nvent-addon/workflow-worker-darwin-arm64',
  'win32-x64': '@nvent-addon/workflow-worker-win32-x64-msvc',
}

function detectPackageName() {
  const key = `${process.platform}-${process.arch}`
  return TARGET_MAP[key] || null
}

function resolveFromPackage(packageName) {
  const pkg = require.resolve(`${packageName}/package.json`)
  const dir = dirname(pkg)
  const bin = process.platform === 'win32' ? 'workflow.exe' : 'workflow'
  const binPath = join(dir, 'bin', bin)
  if (existsSync(binPath)) return binPath
  return null
}

export function getBinaryPath() {
  const fromEnv = process.env.NVENT_WORKFLOW_WORKER_BIN
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv
  }

  const packageName = detectPackageName()
  if (!packageName) {
    throw new Error(
      `Unsupported platform '${process.platform}/${process.arch}'. Set NVENT_WORKFLOW_WORKER_BIN to a custom binary path.`,
    )
  }

  try {
    const resolved = resolveFromPackage(packageName)
    if (resolved) return resolved
  } catch {
    // fallthrough with better final error
  }

  throw new Error(
    `Could not resolve workflow worker binary for ${process.platform}/${process.arch}. Ensure optional dependency '${packageName}' is installed or set NVENT_WORKFLOW_WORKER_BIN.`,
  )
}

export function resolveBinary() {
  return getBinaryPath()
}
