/**
 * iii Function Registry Scanner
 *
 * Scans server/functions/ directories at build time, derives function IDs
 * from file paths, and generates the iii-registry.mjs template that the
 * Nitro plugin imports at runtime.
 *
 * File path → function ID rules:
 *   server/functions/greet.ts           → 'greet'
 *   server/functions/orders/process.ts  → 'orders::process'
 *   server/functions/a/b/c.ts           → 'a::b::c'
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { globby } from 'globby'
import { genString } from 'knitwork'

export interface FunctionMeta {
  /** iii function ID (namespace::name) */
  id: string
  /** Absolute path to the source file */
  absPath: string
  /** Relative path used in the generated import */
  relativePath: string
  /** Optional human-readable description */
  description?: string
}

export interface PythonFunctionMeta {
  /** iii function ID (namespace::name) */
  id: string
  /** Absolute path to the .py source file */
  absPath: string
  /** Relative path within the functions dir */
  relativePath: string
  /**
   * When true, this function gets its own dedicated worker process.
   * Declare in the .py file: `meta = { ..., "standalone": True }`
   * Default: false (runs in the shared worker process)
   */
  standalone: boolean
}

export interface ScannedRegistry {
  functions: FunctionMeta[]
  pythonFunctions: PythonFunctionMeta[]
  workflows: FunctionMeta[]
}

/**
 * Derives the iii function ID from a file path relative to the functions dir.
 * e.g. 'orders/process.ts' → 'orders::process'
 */
export function filePathToFunctionId(relPath: string): string {
  // Strip any file extension (.ts, .js, .py, etc.)
  const noExt = relPath.replace(/\.[a-zA-Z]+$/, '')
  return noExt.split(/[\\/]/).join('::')
}

/**
 * Reads a Python file and checks whether `meta` contains `"standalone": True`.
 * Intentionally a simple regex scan — no need to parse Python AST.
 */
function detectPythonStandalone(absPath: string): boolean {
  try {
    const src = readFileSync(absPath, 'utf-8')
    // Match:  "standalone": True  or  'standalone': True  (with optional spaces)
    return /['"]standalone['"]\s*:\s*True/.test(src)
  }
  catch {
    return false
  }
}

export interface LayerInfo {
  rootDir: string
  serverDir: string
  /**
   * Prefix prepended to every function ID discovered in this layer.
   * Empty string (or undefined) means no prefix — root project convention.
   * e.g. 'auth' → 'login.ts' becomes 'auth::login'
   */
  prefix?: string
}

export interface ScanOptions {
  /** Array of layer info objects (rootDir + serverDir + optional prefix) */
  layerInfos: Array<LayerInfo>
  /** Functions directory relative to serverDir (default: 'functions') */
  functionsDir?: string
  /** Workflows directory relative to serverDir (default: 'workflows') */
  workflowsDir?: string
}

/**
 * Scans all configured function and workflow directories and returns metadata
 * for each discovered function/workflow file.
 */
export async function scanFunctions(opts: ScanOptions): Promise<ScannedRegistry> {
  const { layerInfos, functionsDir = 'functions', workflowsDir = 'workflows' } = opts
  const functions: FunctionMeta[] = []
  const pythonFunctions: PythonFunctionMeta[] = []
  const workflows: FunctionMeta[] = []

  for (const layer of layerInfos) {
    const serverDir = layer.serverDir || join(layer.rootDir, 'server')
    const fnDir = join(serverDir, functionsDir)
    const workflowDir = join(serverDir, workflowsDir)
    const prefix = layer.prefix ? `${layer.prefix}::` : ''

    // Scan standard functions (TS/JS + Python)
    if (existsSync(fnDir)) {
      const [jsFiles, pyFiles] = await Promise.all([
        globby(['**/*.{ts,js,mts,mjs}'], {
          cwd: fnDir,
          absolute: false,
          ignore: ['**/*.d.ts', '**/*.test.*', '**/*.spec.*'],
        }),
        globby(['**/*.py'], {
          cwd: fnDir,
          absolute: false,
          ignore: ['**/__pycache__/**', '**/*.pyc'],
        }),
      ])

      for (const file of jsFiles) {
        functions.push({ id: `${prefix}${filePathToFunctionId(file)}`, absPath: join(fnDir, file), relativePath: file })
      }

      for (const file of pyFiles) {
        const absPath = join(fnDir, file)
        const standalone = detectPythonStandalone(absPath)
        pythonFunctions.push({ id: `${prefix}${filePathToFunctionId(file)}`, absPath, relativePath: file, standalone })
      }
    }

    // Scan workflows (TS/JS)
    if (existsSync(workflowDir)) {
      const jsFiles = await globby(['**/*.{ts,js,mts,mjs}'], {
        cwd: workflowDir,
        absolute: false,
        ignore: ['**/*.d.ts', '**/*.test.*', '**/*.spec.*', '**/README.*'],
      })

      for (const file of jsFiles) {
        workflows.push({ id: `${prefix}${filePathToFunctionId(file)}`, absPath: join(workflowDir, file), relativePath: file })
      }
    }
  }

  return { functions, pythonFunctions, workflows }
}

/**
 * Generates the `.nuxt/iii-registry.mjs` template content.
 *
 * Convention: every function file must export a `defineFunction()` result as default.
 * The file-path-derived ID is always authoritative.
 */
/**
 * Optional map from original absPath → runtime absPath for Python functions.
 * Used in production builds where .py files are copied to .nvent/functions/.
 */
export type PythonPathRewrite = Map<string, string>

export function generateIiiRegistryTemplate(scanned: ScannedRegistry, pythonPathRewrite?: PythonPathRewrite): string {
  const lines: string[] = ['// auto-generated by nvent — do not edit', '']

  // Minimal entry builder: every function file must export a defineFunction() result as default.
  // The file-path-derived ID is always authoritative — no name override from the module.
  // Takes the whole namespace object so Rollup can't statically trace member accesses
  // back to individual modules (avoids "not exported" warnings).
  lines.push(`function _entry(ns, id, absPath) {`)
  lines.push(`  const fn = ns.default`)
  lines.push(`  return { id, description: fn.description, handler: fn.handler, triggers: (fn.triggers ?? []).map(t => ({ ...t, function_id: id })), request_format: fn.request_format, response_format: fn.response_format, filePath: absPath, $workflow: !!fn.$workflow }`)
  lines.push(`}`)
  lines.push('')

  const functionEntries = scanned.functions.map((fn, i) => {
    const ns = `fn${i}`
    lines.push(`import * as ${ns} from ${genString(fn.absPath)}`)
    return `_entry(${ns}, ${genString(fn.id)}, ${genString(fn.absPath)})`
  })

  const workflowEntries = scanned.workflows.map((wf, i) => {
    const ns = `wf${i}`
    lines.push(`import * as ${ns} from ${genString(wf.absPath)}`)
    return `_entry(${ns}, ${genString(wf.id)}, ${genString(wf.absPath)})`
  })

  lines.push('')
  lines.push(`export const registry = {`)
  lines.push(`  functions: [${[...functionEntries, ...workflowEntries].join(', ')}],`)
  lines.push(`  workflows: [${workflowEntries.join(', ')}],`)
  lines.push(`  get triggers() { return this.functions.flatMap(f => f.triggers ?? []) },`)
  lines.push(`}`)
  lines.push('')
  lines.push('export default registry')
  lines.push('')
  lines.push(`export const pythonFunctions = ${JSON.stringify(scanned.pythonFunctions.map(fn => ({
    id: fn.id,
    absPath: pythonPathRewrite?.get(fn.absPath) ?? fn.absPath,
    standalone: fn.standalone,
  })))}`)
  lines.push('')

  return lines.join('\n')
}


/**
 * Generates the entry script for a single standalone Python worker.
 *
 * The script imports shared logic from `_runtime.py` (which is copied to the
 * same `.nuxt/iii-workers/` directory at startup) and wires up one function.
 *
 * Generated output example:
 * ```python
 * # Auto-generated by nvent — do not edit
 * import sys, os
 * sys.path.insert(0, os.path.dirname(__file__))
 * from _runtime import _iii_sdk, _load, _register
 *
 * if __name__ == "__main__":
 *     client = _iii_sdk.register_worker("ws://localhost:49134")
 *     mod = _load("/abs/path/to/fn.py", "fn::id")
 *     _register(client, mod, "fn::id")
 *     client._thread.join()
 * ```
 */
export function generatePythonWorkerScriptForFunction(fn: PythonFunctionMeta, wsUrl: string): string {
  return pythonEntryScript(wsUrl, [fn])
}

/**
 * Generates the shared worker entry script that registers ALL non-standalone
 * Python functions in a single process. This is the default mode.
 */
export function generatePythonWorkerScriptForAll(fns: PythonFunctionMeta[], wsUrl: string): string {
  return pythonEntryScript(wsUrl, fns)
}

/**
 * Builds a minimal Python entry script that:
 *   1. Puts its own directory on sys.path so `_runtime` can be imported
 *   2. Imports shared helpers from `_runtime.py`
 *   3. Connects synchronously via register_worker
 *   4. Loads and registers each function
 *   5. Keeps alive by joining the SDK background thread
 */
function pythonEntryScript(wsUrl: string, fns: PythonFunctionMeta[]): string {
  const lines = [
    '# Auto-generated by nvent — do not edit',
    'import sys, os',
    'sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))',
    'from _runtime import _iii_sdk, _load, _register',
    '',
    '',
    'if __name__ == "__main__":',
    `    client = _iii_sdk.register_worker(${JSON.stringify(wsUrl)})`,
  ]

  for (const fn of fns) {
    lines.push(`    mod = _load(${JSON.stringify(fn.absPath)}, ${JSON.stringify(fn.id)})`)
    lines.push(`    _register(client, mod, ${JSON.stringify(fn.id)})`)
  }

  lines.push(
    '    # Keep process alive until externally killed',
    '    client._thread.join()',
    '',
  )

  return lines.join('\n')
}

