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
import { join, dirname, basename, relative, isAbsolute } from 'node:path'

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
 * `extraPaths` is a list of additional relative or absolute paths to include.
 *
 * Best-effort: silently skips on any error.
 */
export function writePyrightConfig(options: {
  rootDir: string
  devPath: string
  includePaths: string[]
  extraPaths?: string[]
}): void {
  try {
    const { rootDir, devPath, includePaths, extraPaths = [] } = options

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

    // Add extraPaths (handle relative to rootDir)
    for (const p of extraPaths) {
      const absPath = isAbsolute(p) ? p : join(rootDir, p)
      const relPath = relative(rootDir, absPath)
      if (!include.includes(relPath)) include.push(relPath)
    }

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
 * Ensures a Python virtual environment exists if a relative devPath is provided.
 * If the path ends in /bin/python or /bin/python3, it extracts the venv directory
 * and runs `python3 -m venv <dir>` if it doesn't exist.
 */
export async function ensurePythonVenv(pythonBin: string, logLevel: string): Promise<void> {
  // Only handle paths that look like they are inside a venv (e.g. .venv/bin/python3 or .venv/bin/python)
  if (!pythonBin.includes('/bin/python')) return

  if (existsSync(pythonBin)) return

  const binDir = dirname(pythonBin)
  const venvDir = dirname(binDir)

  if (logLevel !== 'none') console.log(`[nvent] Creating Python virtual environment at ${venvDir}`)

  return new Promise((resolve) => {
    // We use the system 'python3' to create the venv.
    // Use -m venv --without-pip if needed, but usually we want pip.
    const proc = spawn('python3', ['-m', 'venv', venvDir], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    proc.on('exit', (code) => {
      if (code !== 0 && logLevel !== 'none') console.error(`[nvent] venv creation failed (code=${code})`)
      else if (code === 0 && logLevel !== 'none') console.log('[nvent] Python virtual environment created')
      resolve()
    })
    proc.on('error', (err) => {
      if (logLevel !== 'none') console.error(`[nvent] venv creation error: ${err.message}`)
      resolve()
    })
  })
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
 * Install specific Python packages via pip.
 */
export async function installPythonPackages(
  packages: string[],
  pythonBin: string,
  logLevel: string,
): Promise<void> {
  if (packages.length === 0) return
  if (logLevel !== 'none') console.log(`[nvent] Installing Python packages: ${packages.join(', ')}`)
  return new Promise((resolve) => {
    const proc = spawn(pythonBin, ['-m', 'pip', 'install', ...packages, '--upgrade', '--quiet'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('exit', (code) => {
      if (code !== 0 && logLevel !== 'none') console.error(`[nvent] pip install failed (code=${code}):\n${stderr.trim()}`)
      else if (code === 0 && logLevel !== 'none') console.log('[nvent] Python packages installed')
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
