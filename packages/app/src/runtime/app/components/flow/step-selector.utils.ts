export function formatTimeAgo(timestamp: string | number | Date): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  if (seconds > 10) return `${seconds}s ago`
  return 'just now'
}

export function getStepStatusBg(status?: string): string {
  switch (status) {
    case 'completed': return 'bg-emerald-50 dark:bg-emerald-900/20'
    case 'failed': return 'bg-red-50 dark:bg-red-900/20'
    case 'stalled': return 'bg-amber-50 dark:bg-amber-900/20'
    case 'running': return 'bg-blue-50 dark:bg-blue-900/20'
    default: return 'bg-gray-50 dark:bg-gray-900/20'
  }
}

export function getStepStatusIcon(status?: string): string {
  switch (status) {
    case 'completed': return 'i-lucide-check-circle'
    case 'failed': return 'i-lucide-x-circle'
    case 'stalled': return 'i-lucide-alert-triangle'
    case 'running': return 'i-lucide-loader-circle'
    default: return 'i-lucide-circle'
  }
}

export function getStepStatusIconColor(status?: string): string {
  switch (status) {
    case 'completed': return 'text-emerald-600 dark:text-emerald-400'
    case 'failed': return 'text-red-600 dark:text-red-400'
    case 'stalled': return 'text-amber-600 dark:text-amber-400'
    case 'running': return 'text-blue-600 dark:text-blue-400 animate-spin'
    default: return 'text-gray-400'
  }
}

export function getStepStatusTextColor(status?: string): string {
  switch (status) {
    case 'completed': return 'text-emerald-600 dark:text-emerald-400'
    case 'failed': return 'text-red-600 dark:text-red-400'
    case 'stalled': return 'text-amber-600 dark:text-amber-400'
    case 'running': return 'text-blue-600 dark:text-blue-400'
    default: return 'text-gray-500'
  }
}

export function isAwaitStepKey(key: string): boolean {
  return key.includes(':await-')
}

export function getAwaitPositionLabel(key: string): string {
  if (key.includes(':await-before')) return 'before'
  if (key.includes(':await-after')) return 'after'
  return ''
}

export function isVarStep(step: any): boolean {
  return step?.functionId === 'workflow::internal-var-set'
}

export function getVarStepKey(step: any): string | null {
  if (!isVarStep(step)) return null
  const label = typeof step?.label === 'string' ? step.label.trim() : ''
  if (label.startsWith('var:')) {
    const key = label.slice('var:'.length).trim()
    return key.length > 0 ? key : null
  }
  return null
}

export function getStepDisplayName(step: any): string {
  const key = String(step?.key || '')
  if (key.startsWith('loop-group:')) {
    const groupId = key.split(':')[1] || 'loop'
    return `Loop ${groupId.toUpperCase()}`
  }

  if (isVarStep(step)) {
    const varKey = getVarStepKey(step)
    if (varKey) return `var:${varKey}`
    return 'var'
  }

  const label = typeof step?.label === 'string' ? step.label.trim() : ''
  if (label.length > 0) return label

  if (key.includes(':await-')) {
    const base = key.split(':await-')[0] || key
    if (base.includes('::')) {
      return base.split('::').filter(Boolean).pop() || base
    }
    return base
  }

  if (key.includes('::')) {
    return key.split('::').filter(Boolean).pop() || key
  }
  return key
}

export function getLoopModeLabel(mode?: string): string {
  if (mode === 'sequential') return 'Sequential'
  if (mode === 'batch') return 'Batch'
  return 'Parallel'
}

export function getLoopModeColor(mode?: string): string {
  if (mode === 'sequential') return 'warning'
  if (mode === 'batch') return 'info'
  return 'success'
}

export function getResultModeLabel(mode?: string): string {
  switch (mode) {
    case 'store': return 'Result: store'
    case 'stream': return 'Result: stream'
    case 'memory': return 'Result: memory'
    default: return 'Result: memory'
  }
}

export function getResultModeColor(mode?: string): 'success' | 'info' | 'warning' | 'neutral' {
  switch (mode) {
    case 'store': return 'success'
    case 'stream': return 'info'
    case 'memory': return 'warning'
    default: return 'neutral'
  }
}

export function getResultStateLabel(step: any): string {
  if (step?.resultState === 'ready') return 'ready'
  if (step?.resultState === 'pruned') return 'pruned'
  return 'pending'
}

export function getResultStateColor(step: any): 'success' | 'warning' | 'neutral' {
  if (step?.resultState === 'ready') return 'success'
  if (step?.resultState === 'pruned') return 'warning'
  return 'neutral'
}

export function getAwaitTypeIcon(type?: string): string {
  switch (type) {
    case 'webhook': return 'i-lucide-webhook'
    case 'event': return 'i-lucide-zap'
    case 'time': return 'i-lucide-clock'
    case 'schedule': return 'i-lucide-calendar-clock'
    default: return 'i-lucide-timer'
  }
}

export function getAwaitTypeLabel(type?: string): string {
  switch (type) {
    case 'webhook': return 'Webhook'
    case 'event': return 'Event'
    case 'time': return 'Time'
    case 'schedule': return 'Schedule'
    default: return 'Await'
  }
}

export function getAwaitBadgeColor(status?: string): string {
  switch (status) {
    case 'waiting': return 'warning'
    case 'completed': return 'success'
    case 'timeout': return 'error'
    default: return 'neutral'
  }
}

export function getAwaitConfigBgClass(status?: string): string {
  switch (status) {
    case 'waiting':
      return 'bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-900/30 text-amber-700 dark:text-amber-300'
    case 'completed':
      return 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-900/30 text-emerald-700 dark:text-emerald-300'
    case 'timeout':
      return 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-900/30 text-red-700 dark:text-red-300'
    default:
      return 'bg-gray-50 dark:bg-gray-900/10 border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300'
  }
}

export function getAwaitIconColor(status?: string): string {
  switch (status) {
    case 'waiting': return 'text-amber-600 dark:text-amber-400'
    case 'completed': return 'text-emerald-600 dark:text-emerald-400'
    case 'timeout': return 'text-red-600 dark:text-red-400'
    default: return 'text-gray-600 dark:text-gray-400'
  }
}

export function getAwaitTextColor(status?: string): string {
  switch (status) {
    case 'waiting': return 'text-amber-700 dark:text-amber-300'
    case 'completed': return 'text-emerald-700 dark:text-emerald-300'
    case 'timeout': return 'text-red-700 dark:text-red-300'
    default: return 'text-gray-700 dark:text-gray-300'
  }
}

export function getMethodBadgeColor(method?: string): string {
  switch (method?.toUpperCase()) {
    case 'GET': return 'primary'
    case 'POST': return 'success'
    case 'PUT': return 'warning'
    case 'DELETE': return 'error'
    default: return 'neutral'
  }
}

export function getTimeoutActionColor(action?: string): string {
  switch (action) {
    case 'fail': return 'error'
    case 'continue': return 'success'
    case 'retry': return 'warning'
    default: return 'neutral'
  }
}

export function formatDuration(ms: number): string {
  if (!ms) return '—'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    const remainingHours = hours % 24
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  }
  if (minutes > 0) {
    const remainingSeconds = seconds % 60
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }
  return `${seconds}s`
}

export function formatScheduledTime(timestamp: string | number | Date): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return 'No schedule'

  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}