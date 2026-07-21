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
export const MIN_SUPPORTED_III_VERSION = '0.21.5'

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

function getWorkerPlatformAsset(version: string): PlatformAsset {
  const platform = process.platform
  const arch = process.arch

  const tag = toReleaseTag(version)
  const base = `${GITHUB_RELEASE_BASE}/${tag}`

  if (platform === 'linux' && arch === 'x64') {
    return { url: `${base}/iii-worker-x86_64-unknown-linux-gnu.tar.gz`, ext: 'tar.gz' }
  }
  if (platform === 'linux' && arch === 'arm64') {
    return { url: `${base}/iii-worker-aarch64-unknown-linux-gnu.tar.gz`, ext: 'tar.gz' }
  }
  if (platform === 'darwin' && arch === 'x64') {
    return { url: `${base}/iii-worker-x86_64-apple-darwin.tar.gz`, ext: 'tar.gz' }
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return { url: `${base}/iii-worker-aarch64-apple-darwin.tar.gz`, ext: 'tar.gz' }
  }
  if (platform === 'win32' && arch === 'x64') {
    return { url: `${base}/iii-worker-x86_64-pc-windows-msvc.zip`, ext: 'zip' }
  }
  if (platform === 'win32' && arch === 'arm64') {
    return { url: `${base}/iii-worker-aarch64-pc-windows-msvc.zip`, ext: 'zip' }
  }

  throw new Error(`Unsupported platform for iii-worker: ${platform}/${arch}`)
}

/**
 * Extracts the plain semver string from a GitHub tag_name.
 * 'iii/v0.8.2' → '0.8.2',  'v0.8.2' → '0.8.2',  '0.8.2' → '0.8.2'
 */
export function semverFromTag(tag: string): string {
  return tag.replace(/^.*\/v?/, '').replace(/^v/, '')
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a)
  const parsedB = parseSemver(b)
  if (!parsedA || !parsedB) return 0
  if (parsedA[0] !== parsedB[0]) return parsedA[0] - parsedB[0]
  if (parsedA[1] !== parsedB[1]) return parsedA[1] - parsedB[1]
  return parsedA[2] - parsedB[2]
}

export function assertSupportedIiiVersion(version: string): void {
  if (!version || version === 'latest') return
  const normalized = semverFromTag(version)
  if (!parseSemver(normalized)) {
    throw new Error(`[nvent] Invalid iii version '${version}'. Expected formats: latest, iii/vX.Y.Z, vX.Y.Z, or X.Y.Z.`)
  }
  if (compareSemver(normalized, MIN_SUPPORTED_III_VERSION) < 0) {
    throw new Error(
      `[nvent] iii version '${version}' is not supported. Minimum supported version is iii/v${MIN_SUPPORTED_III_VERSION}.`,
    )
  }
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
  if (res.status === 403 || res.status === 429) {
    const retryAfter = res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset')
    throw new RateLimitError(`GitHub API rate limit exceeded${retryAfter ? ` (retry after ${retryAfter})` : ''}`)
  }
  if (!res.ok) throw new Error(`Failed to fetch latest iii version: ${res.statusText}`)
  const data = await res.json() as { tag_name: string }
  // Return the raw tag_name so the download URL is constructed correctly
  return data.tag_name
}

class RateLimitError extends Error {}

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
    try {
      version = await fetchLatestVersion()
      if (logLevel === 'info') logger.info(`Latest iii engine version: ${version}`)
    }
    catch (err) {
      if (err instanceof RateLimitError) {
        if (existsSync(binaryPath)) {
          logger.warn(`[nvent] ${err.message} — using existing binary at ${binaryPath}`)
          return binaryPath
        }
        throw new Error(`${err.message} and no existing iii binary found. Specify a version in nvent config (e.g. version: '0.8.0') to avoid GitHub API calls.`)
      }
      throw err
    }
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
  // Try direct download first; if that fails (404/etc), try alternative
  // tag forms (namespaced `iii/...`) and finally query the GitHub API
  // for the release assets to pick a matching binary.
  const tried: string[] = []
  async function tryDownloadForVersion(ver: string): Promise<boolean> {
    try {
      const a = getPlatformAsset(ver)
      tried.push(a.url)
      await downloadAndExtract(a.url, a.ext, binDir, logLevel)
      return true
    }
    catch (err) {
      // bubble up to try other variants
      if (logLevel === 'info') logger.info(`Download for ${ver} failed: ${String(err)}`)
      return false
    }
  }

  let downloaded = false
  // First try the exact form we computed above
  downloaded = await tryDownloadForVersion(version)

  // If not found and version was not namespaced, try common variants
  if (!downloaded && !version.includes('/')) {
    const releaseTag = toReleaseTag(version)
    const variants = [
      `iii/${releaseTag}`,
      releaseTag,
      semverFromTag(releaseTag),
      `iii/${semverFromTag(releaseTag)}`,
    ]
    for (const v of variants) {
      if (downloaded) break
      if (v === version) continue
      downloaded = await tryDownloadForVersion(v)
    }
  }

  // Fallback: query GitHub Releases API for the given tag(s) and pick an asset
  if (!downloaded) {
    const candidateTags = [version]
    if (!version.includes('/')) candidateTags.push(toReleaseTag(version), `iii/${toReleaseTag(version)}`)
    for (const tag of candidateTags) {
      try {
        const apiUrl = `https://api.github.com/repos/iii-hq/iii/releases/tags/${encodeURIComponent(tag)}`
        if (logLevel === 'info') logger.info(`Querying GitHub Release: ${apiUrl}`)
        const res = await fetch(apiUrl, { headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } })
        if (!res.ok) {
          if (logLevel === 'info') logger.info(`GitHub API responded ${res.status} ${res.statusText} for tag ${tag}`)
          continue
        }
        const data = await res.json() as any
        const assets = Array.isArray(data.assets) ? data.assets : []
        // Prefer assets matching our platform/arch substring
        const platformCandidates = [
          'x86_64-unknown-linux-gnu',
          'aarch64-unknown-linux-gnu',
          'x86_64-apple-darwin',
          'aarch64-apple-darwin',
          'x86_64-pc-windows-msvc',
          'aarch64-pc-windows-msvc',
        ]
        const match = assets.find((a: any) => platformCandidates.some(p => a.name.includes(p)))
        if (match && match.browser_download_url) {
          if (logLevel === 'info') logger.info(`Found asset via GitHub API: ${match.name}`)
          await downloadAndExtract(match.browser_download_url, match.name.endsWith('.zip') ? 'zip' : 'tar.gz', binDir, logLevel)
          downloaded = true
          break
        }
      }
      catch (err) {
        if (logLevel === 'info') logger.info(`GitHub API lookup failed for tag ${tag}: ${String(err)}`)
        continue
      }
    }
  }

  if (!downloaded) {
    // Attempt to list available release tags to provide a helpful error.
    try {
      const releasesRes = await fetch('https://api.github.com/repos/iii-hq/iii/releases?per_page=50', {
        headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      })
      let tags: string[] = []
      if (releasesRes.ok) {
        const releases = await releasesRes.json() as Array<{ tag_name?: string }>
        tags = releases.map(r => r.tag_name).filter(Boolean) as string[]
      }
      else {
        // Fallback to /tags if /releases is not accessible or empty
        try {
          const tagsRes = await fetch('https://api.github.com/repos/iii-hq/iii/tags?per_page=50', {
            headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
          })
          if (tagsRes.ok) {
            const tagsData = await tagsRes.json() as Array<{ name?: string }>
            tags = tagsData.map(t => t.name).filter(Boolean) as string[]
          }
        }
        catch {
          // ignore fallback failure
        }
      }

      const shown = tags.slice(0, 20)
      const tagPart = shown.length ? ` Available release tags (first ${shown.length}): ${shown.join(', ')}.` : ''
      throw new Error(
        `Failed to download iii engine from tried URLs: ${tried.join(', ')}.`
        + tagPart
        + ` Set a matching 'nvent.iii.version' in your nuxt config (e.g. 'iii/v0.22.1' or 'v0.22.1').`,
      )
    }
    catch (err) {
      // If anything here fails, fall back to the generic message but include tried URLs.
      throw new Error(`Failed to download iii engine from tried URLs: ${tried.join(', ')}. (${String(err)})`)
    }
  }

  // Make binary executable on Unix
  if (process.platform !== 'win32') {
    chmodSync(binaryPath, 0o755)
  }

  const installedVersion = await getCurrentVersion(binaryPath)
  if (logLevel === 'info') logger.info(`iii engine v${installedVersion} installed at ${binaryPath}`)

  return binaryPath
}

/**
 * Ensures the managed iii-worker binary is present for engine module workers
 * like queue/state/cron/stream on newer iii releases.
 */
export async function ensureIiiWorker(options: InstallOptions): Promise<string> {
  const { binDir } = options
  const logLevel = options.logLevel ?? 'warn'
  const binaryName = process.platform === 'win32' ? 'iii-worker.exe' : 'iii-worker'
  const binaryPath = join(binDir, binaryName)

  let version = options.version
  if (!version || version === 'latest') {
    if (logLevel === 'info') logger.info('Resolving latest iii-worker version...')
    version = await fetchLatestVersion()
  }

  if (existsSync(binaryPath)) {
    const currentVersion = await getCurrentVersion(binaryPath)
    const wantedSemver = semverFromTag(version)
    if (currentVersion === wantedSemver) {
      if (logLevel === 'info') logger.info(`iii-worker v${wantedSemver} already installed at ${binaryPath}`)
      return binaryPath
    }
  }

  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true })
  }

  const asset = getWorkerPlatformAsset(version)
  await downloadAndExtract(asset.url, asset.ext, binDir, logLevel)

  if (!existsSync(binaryPath)) {
    throw new Error(`iii-worker binary not found at ${binaryPath} after extraction`)
  }

  if (process.platform !== 'win32') {
    chmodSync(binaryPath, 0o755)
  }

  if (logLevel === 'info') logger.info(`iii-worker ${version} installed at ${binaryPath}`)
  return binaryPath
}
