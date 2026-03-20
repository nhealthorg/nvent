/**
 * iii Console — Binary Installer + Process Manager
 *
 * Handles downloading the `iii-console` binary from GitHub releases and
 * managing its lifecycle (start/stop). The console is a separate binary
 * from the engine; it connects to the running engine and serves a web UI
 * on port 3113.
 *
 * Only active when `console.ui` is enabled in the nvent module config.
 */

import { existsSync, mkdirSync, chmodSync, createWriteStream, unlinkSync } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { consola } from 'consola'

const execAsync = promisify(exec)
const logger = consola.withTag('nvent:console')

const GITHUB_RELEASE_BASE = 'https://github.com/iii-hq/iii/releases/download'

// ---------------------------------------------------------------------------
// Binary installer
// ---------------------------------------------------------------------------

interface PlatformAsset {
  url: string
  ext: 'tar.gz' | 'zip'
}

function getConsolePlatformAsset(version: string): PlatformAsset {
  const platform = process.platform
  const arch = process.arch
  const tag = toReleaseTag(version)
  const base = `${GITHUB_RELEASE_BASE}/${tag}`

  if (platform === 'linux' && arch === 'x64') {
    return { url: `${base}/iii-console-x86_64-unknown-linux-gnu.tar.gz`, ext: 'tar.gz' }
  }
  if (platform === 'linux' && arch === 'arm64') {
    return { url: `${base}/iii-console-aarch64-unknown-linux-gnu.tar.gz`, ext: 'tar.gz' }
  }
  if (platform === 'darwin' && arch === 'x64') {
    return { url: `${base}/iii-console-x86_64-apple-darwin.tar.gz`, ext: 'tar.gz' }
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return { url: `${base}/iii-console-aarch64-apple-darwin.tar.gz`, ext: 'tar.gz' }
  }
  if (platform === 'win32' && arch === 'x64') {
    return { url: `${base}/iii-console-x86_64-pc-windows-msvc.zip`, ext: 'zip' }
  }
  if (platform === 'win32' && arch === 'arm64') {
    return { url: `${base}/iii-console-aarch64-pc-windows-msvc.zip`, ext: 'zip' }
  }

  throw new Error(`Unsupported platform for iii-console: ${platform}/${arch}`)
}

function semverFromTag(tag: string): string {
  return tag.replace(/^.*\/v?/, '').replace(/^v/, '')
}

function toReleaseTag(version: string): string {
  if (version.includes('/')) return version
  return `v${version.replace(/^v/, '')}`
}

async function fetchLatestConsoleVersion(): Promise<string> {
  const res = await fetch('https://api.github.com/repos/iii-hq/iii/releases/latest', {
    headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  })
  if (res.status === 403 || res.status === 429) {
    const retryAfter = res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset')
    throw new RateLimitError(`GitHub API rate limit exceeded${retryAfter ? ` (retry after ${retryAfter})` : ''}`)
  }
  if (!res.ok) throw new Error(`Failed to fetch latest iii version: ${res.statusText}`)
  const data = await res.json() as { tag_name: string }
  return data.tag_name
}

class RateLimitError extends Error {}

async function getCurrentConsoleVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${binaryPath}" --version`)
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
  catch {
    return null
  }
}

async function downloadAndExtractConsole(assetUrl: string, ext: 'tar.gz' | 'zip', binDir: string, logLevel: string = 'warn'): Promise<void> {
  const archivePath = join(binDir, ext === 'zip' ? 'iii-console.zip' : 'iii-console.tar.gz')

  if (logLevel === 'info') logger.info(`Downloading iii-console from ${assetUrl}`)

  const res = await fetch(assetUrl)
  if (!res.ok) throw new Error(`Failed to download iii-console: ${res.status} ${res.statusText}`)
  if (!res.body) throw new Error('Response body is empty')

  const fileStream = createWriteStream(archivePath)
  await pipeline(res.body as any, fileStream)

  if (logLevel === 'info') logger.info('Extracting iii-console archive...')

  if (ext === 'tar.gz') {
    await execAsync(`tar -xzf "${archivePath}" -C "${binDir}"`)
  }
  else {
    await execAsync(`unzip -o "${archivePath}" -d "${binDir}"`)
  }

  try { unlinkSync(archivePath) } catch {}
}

export interface EnsureConsoleOptions {
  binDir: string
  version: string
  /** Minimum log level for install output. Default: 'warn' */
  logLevel?: 'none' | 'error' | 'warn' | 'info'
}

/**
 * Ensures the iii-console binary is present and at the correct version.
 * Returns the absolute path to the binary.
 */
export async function ensureIiiConsole(options: EnsureConsoleOptions): Promise<string> {
  const { binDir } = options
  const logLevel = options.logLevel ?? 'warn'
  const binaryName = process.platform === 'win32' ? 'iii-console.exe' : 'iii-console'
  const binaryPath = join(binDir, binaryName)

  let version = options.version
  if (!version || version === 'latest') {
    if (logLevel === 'info') logger.info('Resolving latest iii-console version...')
    try {
      version = await fetchLatestConsoleVersion()
      if (logLevel === 'info') logger.info(`Latest iii-console version: ${version}`)
    }
    catch (err) {
      if (err instanceof RateLimitError) {
        if (existsSync(binaryPath)) {
          logger.warn(`[nvent] ${err.message} — using existing iii-console binary at ${binaryPath}`)
          return binaryPath
        }
        throw new Error(`${err.message} and no existing iii-console binary found. Specify a version in nvent config (e.g. console: { version: '0.8.0' }) to avoid GitHub API calls.`)
      }
      throw err
    }
  }

  if (existsSync(binaryPath)) {
    const current = await getCurrentConsoleVersion(binaryPath)
    const wantedSemver = semverFromTag(version)
    if (current === wantedSemver) {
      if (logLevel === 'info') logger.info(`iii-console v${wantedSemver} already installed`)
      return binaryPath
    }
    if (logLevel === 'info') logger.info(`iii-console version mismatch (installed: ${current}, wanted: ${wantedSemver}) — updating`)
  }

  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true })
  }

  const asset = getConsolePlatformAsset(version)
  await downloadAndExtractConsole(asset.url, asset.ext, binDir, logLevel)

  if (!existsSync(binaryPath)) {
    throw new Error(`iii-console binary not found at ${binaryPath} after extraction`)
  }

  chmodSync(binaryPath, 0o755)
  if (logLevel === 'info') logger.info(`iii-console ${version} installed at ${binaryPath}`)
  return binaryPath
}

// ConsoleManager has moved to src/runtime/nitro/utils/console.ts
