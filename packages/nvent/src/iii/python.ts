/**
 * Python Dev-Time Utilities
 *
 * Helpers that run at module setup time (i.e. during `nuxt dev` / `nuxt build`)
 * to prepare the Python environment for nvent step development.
 *
 * These are NOT bundled into the Nitro output — they live here alongside
 * install.ts / console.ts where all other dev-time setup lives.
 */

import { writeFileSync, existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { join, dirname, basename, relative } from 'node:path'

/**
 * Write (or overwrite) a `pyrightconfig.json` at the Nuxt project root so that
 * pyright / Pylance resolves imports from the configured venv automatically.
 *
 * Works for any editor that respects `pyrightconfig.json` (VS Code + Pylance,
 * neovim with pyright LSP, PyCharm with pyright plugin, etc.).
 *
 * `devPath` must be the value of `functions.python.devPath` — a path relative
 * to `rootDir`, e.g. `.venv/bin/python3` or `playground/.venv/bin/python3`.
 * The venvPath / venv pair are derived from this path automatically.
 *
 * `includePaths` is a list of absolute paths that pyright should check;
 * only paths that are inside `rootDir` are included (external paths are skipped).
 *
 * Best-effort: silently skips on any error.
 */
export function writePyrightConfig(options: {
  rootDir: string
  devPath: string
  includePaths: string[]
}): void {
  try {
    const { rootDir, devPath, includePaths } = options

    // Derive venvPath + venv from devPath.
    // e.g. ".venv/bin/python3"         → venvPath=".",         venv=".venv"
    // e.g. "playground/.venv/bin/python3" → venvPath="playground", venv=".venv"
    const binDir = dirname(devPath)      // ".venv/bin"
    const venvDir = dirname(binDir)      // ".venv"
    const venv = basename(venvDir)       // ".venv"
    const venvPath = dirname(venvDir) || '.'  // "." or "playground"

    // Convert absolute includePaths to paths relative to rootDir.
    // Skip paths outside rootDir (e.g. paths from sibling monorepo packages).
    const include = includePaths
      .map(p => relative(rootDir, p))
      .filter(p => !p.startsWith('..'))

    const config: Record<string, unknown> = { venvPath, venv }
    if (include.length > 0) config.include = include

    writeFileSync(
      join(rootDir, 'pyrightconfig.json'),
      JSON.stringify(config, null, 2) + '\n',
      'utf-8',
    )
  }
  catch {
    // IDE integration — never block dev startup on a file write failure.
  }
}

/**
 * Install Python dependencies from a requirements.txt file.
 * Runs `python -m pip install -r <path> --quiet`. Resolves even on failure.
 * Call this at module setup time (dev) — production deployments handle pip install separately.
 */
export async function installPythonRequirements(
  requirementsPath: string,
  pythonBin: string,
  logLevel: string,
): Promise<void> {
  if (!existsSync(requirementsPath)) return
  if (logLevel !== 'none') console.log(`[nvent] Installing Python requirements from ${requirementsPath}`)
  return new Promise((resolve) => {
    const proc = spawn(pythonBin, ['-m', 'pip', 'install', '-r', requirementsPath, '--upgrade', '--quiet'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('exit', (code) => {
      if (code !== 0 && logLevel !== 'none') console.error(`[nvent] pip install failed (code=${code}):\n${stderr.trim()}`)
      else if (code === 0 && logLevel !== 'none') console.log('[nvent] Python requirements installed')
      resolve()
    })
    proc.on('error', (err) => {
      if (logLevel !== 'none') console.error(`[nvent] pip install error: ${err.message}`)
      resolve()
    })
  })
}

/**
 * Install nvent.py into the Python venv's site-packages so that
 * `from nvent import ...` is resolved by Pylance / VS Code without
 * any extra configuration by the user.
 *
 * Best-effort: silently skips if python is not found or site-packages
 * is not writable (e.g. system python without a venv).
 */
export function installNventPyToSitePackages(pythonBin: string, nventPyContent: string): void {
  if (!nventPyContent) return
  try {
    const sitePackages = execFileSync(pythonBin, [
      '-c',
      'import site; dirs = site.getsitepackages(); print(dirs[0])',
    ], { encoding: 'utf-8', timeout: 5000 }).trim()

    writeFileSync(join(sitePackages, 'nvent.py'), nventPyContent, 'utf-8')
  }
  catch {
    // python not found, venv not set up yet, or permissions issue — silently skip
  }
}
