import { createError, getHeader, useRuntimeConfig } from '#imports'
import type { H3Event } from 'h3'

export function requireAgentPermitAdmin(event: H3Event, mutation = false): string {
  const config = useRuntimeConfig(event) as unknown as { nventapp?: { agentPermitAdminEnabled?: boolean | string } }
  const enabled = config.nventapp?.agentPermitAdminEnabled
  if (enabled !== true && enabled !== 'true') {
    throw createError({ statusCode: 403, statusMessage: 'Agent permit administration is disabled by the host application.' })
  }
  if (mutation) {
    const origin = getHeader(event, 'origin')
    const fetchSite = getHeader(event, 'sec-fetch-site')
    if (fetchSite === 'cross-site' || !origin || !['same-origin', 'none'].includes(fetchSite || '')) {
      throw createError({ statusCode: 403, statusMessage: 'A same-origin browser request is required.' })
    }
    let originHost = ''
    try { originHost = new URL(origin).host } catch {}
    if (!originHost || originHost !== getHeader(event, 'host')) {
      throw createError({ statusCode: 403, statusMessage: 'Request origin must match the application host.' })
    }
    if (!getHeader(event, 'content-type')?.toLowerCase().startsWith('application/json')) {
      throw createError({ statusCode: 415, statusMessage: 'JSON request required.' })
    }
  }
  const user = event.context.user as { id?: string | number, email?: string } | undefined
  return String(user?.id ?? user?.email ?? 'operator')
}