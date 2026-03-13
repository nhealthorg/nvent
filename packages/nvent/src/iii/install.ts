/**
 * iii Engine Binary Installer
 *
 * Downloads the iii engine binary from GitHub releases for the current
 * platform/arch and makes it executable. Called at module setup time.
 */

import { existsSync, mkdirSync, chmodSync, createWriteStream, unlinkSync } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { consola } from 'consola'

const execAsync = promisify(exec)
const logger = consola.withTag('nvent:iii-install')

const GITHUB_RELEASE_BASE = 'https://github.com/iii-hq/iii/releases/download'

interface PlatformAsset {
  url: string
  ext: 'tar.gz' | 'zip'
}

function getPlatformAsset(version: string): PlatformAsset {
  const platform = process.platform
  const arch = process.arch

  const tag = toReleaseTag(version)

  if (platform === 'linux' && arch === 'x64') {
    return { url: `${GITHUB_RELEASE_BASE}/${tag}/iii-x86_64-unknown-linux-gnu.tar.gz`, ext: 'tar.gz' }
  }
  if (platform === 'linux' && arch === 'arm64') {
    return { url: `${GITHUB_RELEASE_BASE}/${tag}/iii-aarch64-unknown-linux-gnu.tar.gz`, ext: 'tar.gz' }
  }
  if (platform === 'darwin' && arch === 'x64') {
    return { url: `${GITHUB_RELEASE_BASE}/${tag}/iii-x86_64-apple-darwin.tar.gz`, ext: 'tar.gz' }
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return { url: `${GITHUB_RELEASE_BASE}/${tag}/iii-aarch64-apple-darwin.tar.gz`, ext: 'tar.gz' }
  }
  if (platform === 'win32' && arch === 'x64') {
    return { url: `${GITHUB_RELEASE_BASE}/${tag}/iii-x86_64-pc-windows-msvc.zip`, ext: 'zip' }
  }
  if (platform === 'win32' && arch === 'arm64') {
    return { url: `${GITHUB_RELEASE_BASE}/${tag}/iii-aarch64-pc-windows-msvc.zip`, ext: 'zip' }
  }

  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

/**
 * Extracts the plain semver string from a GitHub tag_name.
 * 'iii/v0.8.2' → '0.8.2',  'v0.8.2' → '0.8.2',  '0.8.2' → '0.8.2'
 */
function semverFromTag(tag: string): string {
  return tag.replace(/^.*\/v?/, '').replace(/^v/, '')
}

/**
 * Normalises a version/tag into the GitHub release tag used in download URLs.
 * 'iii/v0.8.2' → 'iii/v0.8.2' (already a namespaced tag)
 * '0.8.2' or 'v0.8.2' → 'v0.8.2' (plain semver → simple v-tag)
 */
function toReleaseTag(version: string): string {
  if (version.includes('/')) return version
  return `v${version.replace(/^v/, '')}`
}

async function fetchLatestVersion(): Promise<string> {
  const res = await fetch('https://api.github.com/repos/iii-hq/iii/releases/latest', {
    headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  })
  if (!res.ok) throw new Error(`Failed to fetch latest iii version: ${res.statusText}`)
  const data = await res.json() as { tag_name: string }
  // Return the raw tag_name so the download URL is constructed correctly
  return data.tag_name
}

async function getCurrentVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${binaryPath}" --version`)
    // Output format: "iii 0.8.0" or similar
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
  catch {
    return null
  }
}

async function downloadAndExtract(assetUrl: string, ext: 'tar.gz' | 'zip', binDir: string, logLevel: string = 'warn'): Promise<void> {
  const archivePath = join(binDir, ext === 'zip' ? 'iii.zip' : 'iii.tar.gz')

  if (logLevel === 'info') logger.info(`Downloading iii engine from ${assetUrl}`)

  const res = await fetch(assetUrl)
  if (!res.ok) throw new Error(`Failed to download iii engine: ${res.status} ${res.statusText}`)
  if (!res.body) throw new Error('Response body is empty')

  // Write archive to disk
  const fileStream = createWriteStream(archivePath)
  await pipeline(res.body as any, fileStream)

  if (logLevel === 'info') logger.info('Extracting archive...')

  if (ext === 'tar.gz') {
    await execAsync(`tar -xzf "${archivePath}" -C "${binDir}"`)
  }
  else {
    await execAsync(`unzip -o "${archivePath}" -d "${binDir}"`)
  }

  // Cleanup archive
  try { unlinkSync(archivePath) } catch {}
}

export interface InstallOptions {
  /** Target directory where the binary will be stored */
  binDir: string
  /** Desired version, e.g. '0.8.0'. Use 'latest' to auto-resolve. */
  version: string
  /** Minimum log level for install output. Default: 'warn' */
  logLevel?: 'none' | 'error' | 'warn' | 'info'
}

/**
 * Ensures the iii engine binary is present and at the correct version.
 * Downloads and extracts from GitHub releases if missing or outdated.
 * Returns the absolute path to the binary.
 */
export async function ensureIiiEngine(options: InstallOptions): Promise<string> {
  const { binDir } = options
  const logLevel = options.logLevel ?? 'warn'
  const binaryName = process.platform === 'win32' ? 'iii.exe' : 'iii'
  const binaryPath = join(binDir, binaryName)

  // Resolve 'latest' to actual version number
  let version = options.version
  if (!version || version === 'latest') {
    if (logLevel === 'info') logger.info('Resolving latest iii engine version...')
    version = await fetchLatestVersion()
    if (logLevel === 'info') logger.info(`Latest iii engine version: ${version}`)
  }

  // Check if binary already exists at the right version
  if (existsSync(binaryPath)) {
    const currentVersion = await getCurrentVersion(binaryPath)
    const wantedSemver = semverFromTag(version)
    if (currentVersion === wantedSemver) {
      if (logLevel === 'info') logger.info(`iii engine v${wantedSemver} already installed at ${binaryPath}`)
      return binaryPath
    }
    if (logLevel === 'info') logger.info(`iii engine version mismatch (have v${currentVersion}, want v${wantedSemver}), reinstalling...`)
  }

  // Create bin directory if it doesn't exist
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true })
  }

  const asset = getPlatformAsset(version)
  await downloadAndExtract(asset.url, asset.ext, binDir, logLevel)

  // Make binary executable on Unix
  if (process.platform !== 'win32') {
    chmodSync(binaryPath, 0o755)
  }

  const installedVersion = await getCurrentVersion(binaryPath)
  if (logLevel === 'info') logger.info(`iii engine v${installedVersion} installed at ${binaryPath}`)

  return binaryPath
}
