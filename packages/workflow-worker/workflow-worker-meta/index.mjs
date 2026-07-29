import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const TARGET_MAP = {
  'linux-x64': ['@nvent-addon/workflow-worker-linux-x64-gnu', '@nvent-addon/workflow-worker-linux-x64-musl'],
  'linux-arm64': ['@nvent-addon/workflow-worker-linux-arm64-gnu', '@nvent-addon/workflow-worker-linux-arm64-musl'],
  'darwin-x64': ['@nvent-addon/workflow-worker-darwin-x64'],
  'darwin-arm64': ['@nvent-addon/workflow-worker-darwin-arm64'],
  'win32-x64': ['@nvent-addon/workflow-worker-win32-x64-msvc'],
}

function detectPackageNames() {
  const key = `${process.platform}-${process.arch}`
  return TARGET_MAP[key] || []
}

function resolveFromPackage(packageName) {
  try {
    const pkg = require.resolve(`${packageName}/package.json`)
    const dir = dirname(pkg)
    const bin = process.platform === 'win32' ? 'workflow.exe' : 'workflow'
    const binPath = join(dir, 'bin', bin)
    if (existsSync(binPath)) return binPath
  } catch {
    // Ignore resolution errors
  }
  return null
}

export function getBinaryPath() {
  const fromEnv = process.env.NVENT_WORKFLOW_WORKER_BIN
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv
  }

  const packageNames = detectPackageNames()
  if (packageNames.length === 0) {
    throw new Error(
      `Unsupported platform '${process.platform}/${process.arch}'. Set NVENT_WORKFLOW_WORKER_BIN to a custom binary path.`,
    )
  }

  for (const packageName of packageNames) {
    const resolved = resolveFromPackage(packageName)
    if (resolved) return resolved
  }

  throw new Error(
    `Could not resolve workflow worker binary for ${process.platform}/${process.arch}. Ensure at least one of these optional dependencies is installed: ${packageNames.join(', ')} or set NVENT_WORKFLOW_WORKER_BIN.`,
  )
}

export function resolveBinary() {
  return getBinaryPath()
}
