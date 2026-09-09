export type NamespaceRole = 'app' | 'workflows' | 'browser' | 'compose'

export interface ResolvedNamespaceSettings {
  mode: 'single' | 'mapped'
  defaultNamespace: string
  map: Record<NamespaceRole, string>
  daemonNamespace: string
  projectNamespace: string
}

const NAMESPACE_ROLES: NamespaceRole[] = ['app', 'workflows', 'browser', 'compose']

function normalizeNamespaceValue(input: string | undefined, fallback: string): string {
  const value = String(input ?? '').trim()
  return value.length > 0 ? value : fallback
}

export function resolveNamespaceMap(input?: { default?: string; map?: Partial<Record<NamespaceRole, string>> }): Record<NamespaceRole, string> {
  const defaultNamespace = normalizeNamespaceValue(input?.default, 'default')
  const rawMap = input?.map ?? {}

  return {
    app: normalizeNamespaceValue(rawMap.app, defaultNamespace),
    workflows: normalizeNamespaceValue(rawMap.workflows, defaultNamespace),
    browser: normalizeNamespaceValue(rawMap.browser, defaultNamespace),
    compose: normalizeNamespaceValue(rawMap.compose, defaultNamespace),
  }
}

export function resolveNamespaceSettings(input?: {
  mode?: string
  default?: string
  map?: Partial<Record<NamespaceRole, string>>
  daemonNamespace?: string
}): ResolvedNamespaceSettings {
  const mode = normalizeNamespaceValue(input?.mode, 'single')
  const defaultNamespace = normalizeNamespaceValue(input?.default, 'default')

  if (mode !== 'single' && mode !== 'mapped') {
    throw new Error(`Unsupported namespace mode: ${mode}. Expected 'single' or 'mapped'.`)
  }

  const map = resolveNamespaceMap({ default: defaultNamespace, map: input?.map })

  const daemonNamespace = normalizeNamespaceValue(input?.daemonNamespace, defaultNamespace)
  const projectNamespace = mode === 'mapped'
    ? map.compose
    : defaultNamespace

  return {
    mode,
    defaultNamespace,
    map,
    daemonNamespace,
    projectNamespace,
  }
}

export function getEffectiveNamespaceForRole(
  role: NamespaceRole,
  input?: { mode?: string; default?: string; map?: Partial<Record<NamespaceRole, string>> },
): string {
  const settings = resolveNamespaceSettings(input)
  return settings.map[role]
}

export function isNamespaceRole(value: string): value is NamespaceRole {
  return NAMESPACE_ROLES.includes(value as NamespaceRole)
}
