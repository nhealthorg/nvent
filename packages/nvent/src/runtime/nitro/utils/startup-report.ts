import consola from 'consola'

export interface NventStartupReportOptions {
  wsUrl: string
  httpPort: number
  httpHost: string
  streamPort: number
  consolePort?: number
  consoleEnabled: boolean
  composeNamespace: string
  projectNamespace?: string
  namespaceMode?: 'single' | 'mapped'
  namespaceMap?: Record<string, string>
  composeFilePath: string
}

export function printNventStartupReport(options: NventStartupReportOptions): void {
  const httpUrl = `http://${options.httpHost}:${options.httpPort}`
  const streamUrl = `ws://${options.httpHost}:${options.streamPort}`
  const consoleUrl = options.consoleEnabled ? `http://${options.httpHost}:${options.consolePort}` : '(disabled)'

  consola.info('[nvent] Runtime')
  consola.info(`  -> iii ws:       ${options.wsUrl}`)
  consola.info(`  -> iii http:     ${httpUrl}`)
  consola.info(`  -> iii stream:   ${streamUrl}`)
  consola.info(`  -> iii console:  ${consoleUrl}`)
  consola.info(`  -> namespace:    ${options.namespaceMode ?? 'single'} / default=${options.namespaceMap?.app ?? 'default'}`)
  consola.info(`  -> compose ns:   ${options.composeNamespace}`)
  consola.info(`  -> project ns:   ${options.projectNamespace ?? options.composeNamespace}`)
  consola.info(`  -> compose file: ${options.composeFilePath}`)
}
