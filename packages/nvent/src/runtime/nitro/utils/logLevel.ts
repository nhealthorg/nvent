export type NventLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'none'

export const LOG_LEVEL_SEVERITY: Record<NventLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  none: 5,
}

export function shouldLogLine(configuredLevel: NventLogLevel | string | undefined, lineLevel: NventLogLevel): boolean {
  const normConfigured = String(configuredLevel ?? 'warn').toLowerCase() as NventLogLevel
  const minSeverity = LOG_LEVEL_SEVERITY[normConfigured] ?? LOG_LEVEL_SEVERITY.warn
  if (minSeverity === LOG_LEVEL_SEVERITY.none) return false
  const lineSeverity = LOG_LEVEL_SEVERITY[lineLevel] ?? LOG_LEVEL_SEVERITY.info
  return lineSeverity >= minSeverity
}
