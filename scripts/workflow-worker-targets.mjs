import { spawnSync } from 'node:child_process'

export const TARGETS = {
  'linux-x64-gnu': {
    triple: 'x86_64-unknown-linux-gnu',
    packageDir: 'packages/workflow-worker/workflow-worker-linux-x64-gnu',
    packageName: '@nvent-addon/workflow-worker-linux-x64-gnu',
    binaryName: 'workflow',
  },
  'linux-x64-musl': {
    triple: 'x86_64-unknown-linux-musl',
    packageDir: 'packages/workflow-worker/workflow-worker-linux-x64-musl',
    packageName: '@nvent-addon/workflow-worker-linux-x64-musl',
    binaryName: 'workflow',
  },
  'linux-arm64-gnu': {
    triple: 'aarch64-unknown-linux-gnu',
    packageDir: 'packages/workflow-worker/workflow-worker-linux-arm64-gnu',
    packageName: '@nvent-addon/workflow-worker-linux-arm64-gnu',
    binaryName: 'workflow',
  },
  'linux-arm64-musl': {
    triple: 'aarch64-unknown-linux-musl',
    packageDir: 'packages/workflow-worker/workflow-worker-linux-arm64-musl',
    packageName: '@nvent-addon/workflow-worker-linux-arm64-musl',
    binaryName: 'workflow',
  },
  'darwin-x64': {
    triple: 'x86_64-apple-darwin',
    packageDir: 'packages/workflow-worker/workflow-worker-darwin-x64',
    packageName: '@nvent-addon/workflow-worker-darwin-x64',
    binaryName: 'workflow',
  },
  'darwin-arm64': {
    triple: 'aarch64-apple-darwin',
    packageDir: 'packages/workflow-worker/workflow-worker-darwin-arm64',
    packageName: '@nvent-addon/workflow-worker-darwin-arm64',
    binaryName: 'workflow',
  },
  'win32-x64-msvc': {
    triple: 'x86_64-pc-windows-msvc',
    packageDir: 'packages/workflow-worker/workflow-worker-win32-x64-msvc',
    packageName: '@nvent-addon/workflow-worker-win32-x64-msvc',
    binaryName: 'workflow.exe',
  },
}

function detectLibc() {
  if (process.platform !== 'linux') return undefined
  // Using process.report if available for glibc detection
  const report = process.report?.getReport?.()
  if (report?.header?.glibcVersionRuntime) {
    return 'gnu'
  }
  // If not glibc, check for musl
  // A common way to check for musl in Node is to see if it's alpine or check ldd
  try {
    const ldd = spawnSync('ldd', ['--version'], { encoding: 'utf8' })
    if (ldd.stdout?.includes('musl') || ldd.stderr?.includes('musl')) {
      return 'musl'
    }
  } catch {
    // ignore
  }
  return 'gnu' // Default to gnu
}

export function detectTargetKey() {
  const libc = detectLibc()
  if (process.platform === 'linux' && process.arch === 'x64') {
    return libc === 'musl' ? 'linux-x64-musl' : 'linux-x64-gnu'
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return libc === 'musl' ? 'linux-arm64-musl' : 'linux-arm64-gnu'
  }
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64'
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64-msvc'
  return null
}

export function resolveTarget(inputKey) {
  const key = inputKey || detectTargetKey()
  if (!key || !TARGETS[key]) {
    throw new Error(
      `Unsupported target '${inputKey || `${process.platform}-${process.arch}`}'. Supported keys: ${Object.keys(TARGETS).join(', ')}`,
    )
  }
  return { key, ...TARGETS[key] }
}
