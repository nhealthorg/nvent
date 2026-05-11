import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'

import { resolveExtendedFunctionAbsPath } from '../../packages/nvent/src/iii/extendedFunctionPath'
import { generateIiiRegistryTemplate } from '../../packages/nvent/src/iii/registry'

describe('extended function path resolution', () => {
  it('rewrites missing .ts to existing sibling .js for registry imports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nvent-ext-fn-'))
    const jsPath = join(dir, 'terminology.js')
    const missingTsPath = join(dir, 'terminology.ts')
    writeFileSync(jsPath, 'export default {}\n', 'utf-8')

    const resolved = resolveExtendedFunctionAbsPath(missingTsPath)
    expect(resolved.absPath).toBe(jsPath)
    expect(resolved.rewrittenFrom).toBe(missingTsPath)

    const registry = generateIiiRegistryTemplate({
      functions: [{ id: 'fhir::terminology::lookup', absPath: resolved.absPath, relativePath: 'terminology.js' }],
      pythonFunctions: [],
    })

    expect(registry).toContain(`import * as fn0 from ${JSON.stringify(jsPath)}`)
  })
})
