export const TARGETS = {
  'linux-x64-gnu': {
    triple: 'x86_64-unknown-linux-gnu',
    packageDir: 'packages/workflow-worker/workflow-worker-linux-x64-gnu',
    packageName: '@nvent-addon/workflow-worker-linux-x64-gnu',
    binaryName: 'workflow',
  },
  'linux-arm64-gnu': {
    triple: 'aarch64-unknown-linux-gnu',
    packageDir: 'packages/workflow-worker/workflow-worker-linux-arm64-gnu',
    packageName: '@nvent-addon/workflow-worker-linux-arm64-gnu',
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
  // A lightweight libc check: prefer glibc unless explicitly musl-like.
  const report = process.report?.getReport?.()
  const glibc = report?.header?.glibcVersionRuntime
  return glibc ? 'gnu' : 'gnu'
}

export function detectTargetKey() {
  if (process.platform === 'linux' && process.arch === 'x64') {
    return detectLibc() === 'gnu' ? 'linux-x64-gnu' : null
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return detectLibc() === 'gnu' ? 'linux-arm64-gnu' : null
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
