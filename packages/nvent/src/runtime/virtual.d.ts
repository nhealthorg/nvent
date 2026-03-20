declare module '#nvent/iii-registry' {
  interface NodeFnInfo {
    name: string
    description?: string
    handler: (input: unknown, ctx: unknown) => Promise<unknown>
    triggers: Array<{ type: string; function_id: string; config?: Record<string, unknown> }>
    enqueues: string[]
    flows: string[]
    stream?: string
    filePath?: string
  }
  export const registry: {
    functions: NodeFnInfo[]
    triggers: Array<{ type: string; function_id: string; config?: Record<string, unknown> }>
  }
  export const pythonFunctions: Array<{ id: string; absPath: string; standalone: boolean }>
}
