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
import { join } from 'node:path'

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
    const proc = spawn(pythonBin, ['-m', 'pip', 'install', '-r', requirementsPath, '--quiet'], {
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
