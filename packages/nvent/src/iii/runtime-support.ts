import { spawn } from 'node:child_process'
import { copyFileSync, chmodSync, existsSync, mkdirSync, statSync, utimesSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { resolveWorkflowBinaryFromPackageRoot } from '../runtime/nitro/utils/workers/workflow'

export type NventLogLevel = 'none' | 'error' | 'warn' | 'info'

export interface ResolveRuntimePortsOptions {
  configuredWsPort?: number
  configuredHttpPort?: number
  configuredStreamPort?: number
  configuredConsolePort?: number
  defaultWsPort?: number
  defaultHttpPort?: number
  defaultStreamPort?: number
  defaultConsolePort?: number
  host?: string
}

export interface ResolvedRuntimePorts {
  wsPort: number
  httpPort: number
  streamPort: number
  consolePort: number
}

export interface CleanupLingeringEngineOptions {
  nventDir: string
  daemonNamespace: string
  logLevel?: NventLogLevel
}

const composeValidateSupportCache = new Map<string, boolean>()

export function getWorkflowBinaryName(): string {
  return process.platform === 'win32' ? 'workflow.exe' : 'workflow'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getProcessList(): Promise<Array<{ pid: number, args: string }>> {
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn('ps', ['-eo', 'pid=,args='], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ps failed: ${stderr.trim() || `exit ${String(code)}`}`))
        return
      }
      resolve(stdout)
    })
  })

  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const firstSpace = line.indexOf(' ')
      if (firstSpace < 0) return null
      const pid = Number.parseInt(line.slice(0, firstSpace).trim(), 10)
      if (!Number.isFinite(pid)) return null
      const args = line.slice(firstSpace + 1).trim()
      return { pid, args }
    })
    .filter((entry): entry is { pid: number, args: string } => !!entry)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function terminateProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  }
  catch {
    return
  }

  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return
    await sleep(100)
  }

  try {
    process.kill(pid, 'SIGKILL')
  }
  catch {
    // Process may already be gone.
  }
}

export async function cleanupLingeringEngineForNamespace(options: CleanupLingeringEngineOptions): Promise<number> {
  const { nventDir, daemonNamespace } = options
  const logLevel = options.logLevel ?? 'warn'
  const expectedConfigPath = join(nventDir, '.compose-state', daemonNamespace, 'engine-config.yaml')

  if (!existsSync(expectedConfigPath)) {
    return 0
  }

  const processes = await getProcessList()
  const candidates = processes
    .filter(({ pid, args }) => {
      if (pid === process.pid) return false
      return args.includes(expectedConfigPath) && args.includes('--config') && args.includes('/iii')
    })
    .map(entry => entry.pid)

  if (candidates.length === 0) {
    return 0
  }

  if (logLevel === 'info' || logLevel === 'warn') {
    console.warn(`[nvent] cleaning up lingering iii engine process for namespace '${daemonNamespace}': ${candidates.join(', ')}`)
  }

  for (const pid of candidates) {
    await terminateProcess(pid)
  }

  return candidates.length
}

async function resolveAvailablePort(
  preferredPort: number,
  host = '127.0.0.1',
  maxAttempts = 25,
  excludedPorts?: Set<number>,
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = preferredPort + i
    if (excludedPorts?.has(port)) {
      continue
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.once('listening', () => {
          server.close(() => resolve())
        })
        server.listen(port, host)
      })
      return port
    }
    catch {
      // Port is occupied; keep scanning only as a fallback.
    }
  }

  return preferredPort
}

async function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.once('listening', () => {
        server.close(() => resolve())
      })
      server.listen(port, host)
    })
    return true
  }
  catch {
    return false
  }
}

export async function resolveRuntimePorts(options: ResolveRuntimePortsOptions): Promise<ResolvedRuntimePorts> {
  const host = options.host ?? '127.0.0.1'
  const defaultWsPort = options.defaultWsPort ?? 49134
  const defaultHttpPort = options.defaultHttpPort ?? 3111
  const defaultStreamPort = options.defaultStreamPort ?? 3112
  const defaultConsolePort = options.defaultConsolePort ?? 3113

  const reservedPorts = new Map<number, string>()

  const reservePort = (port: number, owner: string): number => {
    const existing = reservedPorts.get(port)
    if (existing) {
      throw new Error(`[nvent] Port collision in nvent config: ${owner} and ${existing} both use ${port}. Please set distinct ports.`)
    }
    reservedPorts.set(port, owner)
    return port
  }

  const nextFreePort = async (preferredPort: number, owner: string): Promise<number> => {
    const resolved = await resolveAvailablePort(preferredPort, host, 25, new Set(reservedPorts.keys()))
    return reservePort(resolved, owner)
  }

  const wsPort = options.configuredWsPort != null
    ? reservePort(options.configuredWsPort, 'iii.wsPort')
    : await nextFreePort(defaultWsPort, 'iii.wsPort')

  const httpPort = options.configuredHttpPort != null
    ? reservePort(options.configuredHttpPort, 'iii.httpPort')
    : await nextFreePort(defaultHttpPort, 'iii.httpPort')

  const streamPort = options.configuredStreamPort != null
    ? reservePort(options.configuredStreamPort, 'iii.streamPort')
    : (() => {
        if (reservedPorts.has(defaultStreamPort)) {
          throw new Error(`[nvent] Port collision in nvent config: iii.streamPort default ${defaultStreamPort} is already reserved by ${reservedPorts.get(defaultStreamPort)}. Please set explicit distinct ports.`)
        }
        return defaultStreamPort
      })()

  if (options.configuredStreamPort == null) {
    const streamDefaultAvailable = await isPortAvailable(defaultStreamPort, host)
    if (!streamDefaultAvailable) {
      throw new Error(`[nvent] iii stream default port ${defaultStreamPort} is already in use. To keep iii defaults, free that port before startup, or set nvent.iii.streamPort explicitly.`)
    }
    reservePort(streamPort, 'iii.streamPort')
  }

  const consolePort = options.configuredConsolePort != null
    ? reservePort(options.configuredConsolePort, 'iii.console.port')
    : await nextFreePort(defaultConsolePort, 'iii.console.port')

  return { wsPort, httpPort, streamPort, consolePort }
}

export function pickFirstExistingPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] ?? ''
}

export function stageWorkflowBinary(targetBinDir: string, packageRootDir: string): string | undefined {
  try {
    const source = resolveWorkflowBinaryFromPackageRoot(packageRootDir)
    if (!source) return undefined
    if (!existsSync(source)) return undefined

    mkdirSync(targetBinDir, { recursive: true })
    const target = join(targetBinDir, getWorkflowBinaryName())

    // Avoid replacing a binary that is currently in use when quickly restarting dev.
    if (existsSync(target)) {
      try {
        const sourceStat = statSync(source)
        const targetStat = statSync(target)
        if (sourceStat.size === targetStat.size && sourceStat.mtimeMs === targetStat.mtimeMs) {
          return target
        }
      }
      catch {
        // Fall back to copy below.
      }
    }

    try {
      copyFileSync(source, target)
    }
    catch (err: any) {
      if (err?.code === 'ETXTBSY' && existsSync(target)) {
        return target
      }
      throw err
    }

    utimesSync(target, statSync(source).atime, statSync(source).mtime)
    if (process.platform !== 'win32') {
      chmodSync(target, 0o755)
    }

    return target
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[nvent] workflow worker binary could not be staged to .nvent/bin: ${message}`)
    return undefined
  }
}

export async function validateComposeFile(
  binaryPath: string,
  composeFilePath: string,
  workingDir: string,
  logLevel: NventLogLevel,
): Promise<void> {
  const supportsValidate = await (async () => {
    const cacheKey = `${binaryPath}::${workingDir}`
    if (composeValidateSupportCache.has(cacheKey)) {
      return composeValidateSupportCache.get(cacheKey) === true
    }

    try {
      const output = await new Promise<{ exitCode: number | null, stdout: string, stderr: string }>((resolve, reject) => {
        const child = spawn(binaryPath, ['compose', '--help'], {
          cwd: workingDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        })

        let stdout = ''
        let stderr = ''

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })

        child.on('error', reject)
        child.on('close', (exitCode) => {
          resolve({ exitCode, stdout, stderr })
        })
      })

      const helpText = `${output.stdout}\n${output.stderr}`
      const supported = /(^|\n)\s*validate\b/i.test(helpText)
      composeValidateSupportCache.set(cacheKey, supported)
      return supported
    }
    catch {
      composeValidateSupportCache.set(cacheKey, false)
      return false
    }
  })()

  if (!supportsValidate) {
    if (logLevel === 'info' || logLevel === 'warn') {
      console.warn(`[nvent] compose::validate not supported by iii binary (${binaryPath}); skipping validation.`)
    }
    return
  }

  const args = ['compose', 'validate', '--file', composeFilePath]
  const output = await new Promise<{ exitCode: number | null, stdout: string, stderr: string }>((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr })
    })
  })

  if (output.exitCode === 0) {
    if (logLevel === 'info') {
      console.info(`[nvent] compose::validate passed (${composeFilePath})`)
    }
    return
  }

  const details = [output.stderr.trim(), output.stdout.trim()].filter(Boolean).join('\n')
  if (/unrecognized subcommand\s+['"]?validate['"]?/i.test(details)) {
    const cacheKey = `${binaryPath}::${workingDir}`
    composeValidateSupportCache.set(cacheKey, false)
    if (logLevel === 'info' || logLevel === 'warn') {
      console.warn(`[nvent] compose::validate not supported by iii binary (${binaryPath}); skipping validation.`)
    }
    return
  }

  throw new Error([
    `[nvent] compose::validate failed for ${composeFilePath}`,
    details || `(exitCode=${String(output.exitCode)})`,
  ].join('\n'))
}
