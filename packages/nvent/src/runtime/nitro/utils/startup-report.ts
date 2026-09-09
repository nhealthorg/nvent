export interface NventStartupReportOptions {
  wsUrl: string
  httpPort: number
  httpHost: string
  streamPort: number
  consolePort?: number
  consoleEnabled: boolean
  composeNamespace: string
  composeFilePath: string
}

export function printNventStartupReport(options: NventStartupReportOptions): void {
  const httpUrl = `http://${options.httpHost}:${options.httpPort}`
  const streamUrl = `ws://${options.httpHost}:${options.streamPort}`
  const consoleUrl = options.consoleEnabled ? `http://${options.httpHost}:${options.consolePort}` : '(disabled)'

  console.info('[nvent] Runtime')
  console.info(`  -> iii ws:       ${options.wsUrl}`)
  console.info(`  -> iii http:     ${httpUrl}`)
  console.info(`  -> iii stream:   ${streamUrl}`)
  console.info(`  -> iii console:  ${consoleUrl}`)
  console.info(`  -> compose ns:   ${options.composeNamespace}`)
  console.info(`  -> compose file: ${options.composeFilePath}`)
}
