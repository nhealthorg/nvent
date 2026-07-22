import { dirname, join, resolve, existsSync } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync as fsExistsSync } from 'node:fs'

function isSentinelImportMetaUrl(importMetaUrl: string): boolean {
  return !importMetaUrl || importMetaUrl.endsWith('/_entry.js')
}

function resolveFromEntryArgv(): string | undefined {
  const entry = process.argv[1]
  if (!entry) return undefined
  // Expected shape in production/preview: <outputDir>/server/index.mjs
  // We derive <outputDir>/nvent from the actual launched script path.
  const serverDir = dirname(entry)
  const candidate = join(serverDir, '..', 'nvent')
  if (fsExistsSync(candidate)) return candidate
  return undefined
}

export function resolveNventDir(importMetaUrl: string): string {
  if (process.env.NVENT_DIR) return process.env.NVENT_DIR

  // Nitro bundler replaces import.meta.url with globalThis._importMeta_.url.
  // The chunk initializes that global with a sentinel "file:///_entry.js" before
  // index.mjs runs. Guard against that value to avoid resolving to "/nvent".
  if (importMetaUrl && !isSentinelImportMetaUrl(importMetaUrl)) {
    try {
      const serverDir = dirname(fileURLToPath(importMetaUrl))
      const candidate = join(serverDir, '..', 'nvent')
      // Reject root-level paths that indicate the sentinel was used.
      // Also verify the directory exists to avoid resolving to .nuxt/nvent 
      // when we actually want the node_modules location in dev.
      if (candidate !== '/nvent' && fsExistsSync(candidate)) {
        console.log(`[nvent] resolveNventDir via importMetaUrl: ${candidate}`)
        return candidate
      }
    }
    catch (e) {
      console.warn(`[nvent] resolveNventDir: failed to parse importMetaUrl=${importMetaUrl}`, e)
    }
  }

  const fromArgv = resolveFromEntryArgv()
  if (fromArgv) {
    console.log(`[nvent] resolveNventDir via process.argv[1]: ${fromArgv} (importMetaUrl=${importMetaUrl})`)
    return fromArgv
  }

  // Fallback for dev mode where imports might be symlinked or virtualized
  // .nuxt/nvent is often a placeholder, we prefer the node_modules or output loc.
  const fromCwd = resolve(process.cwd(), 'nvent')
  console.log(`[nvent] resolveNventDir via CWD fallback: ${fromCwd} (importMetaUrl=${importMetaUrl})`)
  return fromCwd
}
