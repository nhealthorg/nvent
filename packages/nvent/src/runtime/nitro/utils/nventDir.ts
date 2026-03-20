import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveNventDir(importMetaUrl: string): string {
  if (process.env.NVENT_DIR) return process.env.NVENT_DIR

  // Nitro bundler replaces import.meta.url with globalThis._importMeta_.url.
  // The chunk initializes that global with a sentinel "file:///_entry.js" before
  // index.mjs runs. Guard against that value to avoid resolving to "/nvent".
  if (importMetaUrl && !importMetaUrl.endsWith('/_entry.js')) {
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

  // Fallback: nuxi preview runs node server/index.mjs with CWD = .output/
  // so nvent/ is a direct child.
  const fromCwd = resolve(process.cwd(), 'nvent')
  console.log(`[nvent] resolveNventDir via CWD fallback: ${fromCwd} (importMetaUrl=${importMetaUrl})`)
  return fromCwd
}
