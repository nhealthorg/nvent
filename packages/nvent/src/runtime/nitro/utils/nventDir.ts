import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function isSentinelImportMetaUrl(importMetaUrl: string): boolean {
  return !importMetaUrl || importMetaUrl.endsWith('/_entry.js')
}

function resolveFromEntryArgv(): string | undefined {
  const entry = process.argv[1]
  if (!entry) return undefined
  // Expected shape in production/preview: <outputDir>/server/index.mjs
  // We derive <outputDir>/nvent from the actual launched script path.
  const serverDir = dirname(entry)
  return join(serverDir, '..', 'nvent')
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
      // Reject root-level paths that indicate the sentinel was used
      if (candidate !== '/nvent') {
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

  // Fallback: nuxi preview runs node server/index.mjs with CWD = .output/
  // so nvent/ is a direct child.
  const fromCwd = resolve(process.cwd(), 'nvent')
  console.log(`[nvent] resolveNventDir via CWD fallback: ${fromCwd} (importMetaUrl=${importMetaUrl})`)
  return fromCwd
}
