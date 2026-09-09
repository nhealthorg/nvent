import { dirname, join, resolve } from 'node:path'
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

      // Robust search for the 'nvent' directory by walking up from the current chunk.
      // In production, we expect .output/nvent to be a sibling of .output/server.
      // If we are in .output/server/chunks/..., we need to walk up several levels.
      let current = serverDir
      for (let i = 0; i < 4; i++) {
        const candidate = join(current, 'nvent')
        if (fsExistsSync(candidate)) {
          // Verify it's not a false positive at root level.
          if (candidate !== '/nvent') {
            return candidate
          }
        }
        const parent = dirname(current)
        if (parent === current) break
        current = parent
      }
    }
    catch (e) {
      // ignore
    }
  }

  const fromArgv = resolveFromEntryArgv()
  if (fromArgv) return fromArgv

  // Dev fallback: prefer Nuxt-native .nuxt/nvent runtime roots.
  let current = process.cwd()
  for (let i = 0; i < 3; i++) {
    const nuxtCandidate = join(current, '.nuxt', 'nvent')
    if (fsExistsSync(nuxtCandidate)) return nuxtCandidate

    const legacyCandidate = join(current, 'node_modules', '.nvent')
    if (fsExistsSync(legacyCandidate)) return legacyCandidate

    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  // Final fallback: use a local 'nvent' directory if it exists, otherwise
  // default to CWD/nvent (even if missing) to let the caller handle errors.
  const localNvent = resolve(process.cwd(), 'nvent')
  return localNvent
}
