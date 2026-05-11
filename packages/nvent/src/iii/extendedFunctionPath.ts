import { existsSync } from 'node:fs'

export interface ExtendedFunctionPathResolution {
  absPath: string
  rewrittenFrom?: string
}

/**
 * Resolve an extended function path to a runtime-importable file.
 *
 * Behavior:
 * - If the original file exists, keep it unchanged.
 * - If it does not exist and ends with `.ts`, try sibling `.js`, `.mjs`, `.cjs`.
 * - If none exists, keep original path.
 */
export function resolveExtendedFunctionAbsPath(absPath: string): ExtendedFunctionPathResolution {
  if (existsSync(absPath)) {
    return { absPath }
  }

  if (!absPath.endsWith('.ts')) {
    return { absPath }
  }

  const base = absPath.slice(0, -3)
  for (const ext of ['.js', '.mjs', '.cjs']) {
    const candidate = `${base}${ext}`
    if (existsSync(candidate)) {
      return {
        absPath: candidate,
        rewrittenFrom: absPath,
      }
    }
  }

  return { absPath }
}
