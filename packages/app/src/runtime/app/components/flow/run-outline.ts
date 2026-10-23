export interface OutlineItem {
  value: string
  label: string
  step: any
  clickable?: boolean
}

export interface OutlineNode {
  item: OutlineItem
  kind: 'if' | 'reduce' | 'loop' | 'step'
  children: OutlineNode[]
  branches: Array<{ path: 'then' | 'else', selected?: boolean, children: OutlineNode[] }>
  skipped: boolean
}

export function ifCheckpointFor(checkpoints: Record<string, any> | undefined, id: string, iterationUid = id): any {
  if (id.includes('#')) return checkpoints?.[id]
  const suffix = iterationUid.includes('#') ? iterationUid.slice(iterationUid.indexOf('#')) : ''
  return checkpoints?.[`${id}${suffix}`]
}

export function ifBranchSelection(checkpoints: Record<string, any> | undefined, branch: any, iterationUid?: string): boolean | undefined {
  if (!branch?.if) return undefined
  const selected = ifCheckpointFor(checkpoints, branch.if, iterationUid || branch.if)?.selected
  return selected ? selected === branch.path : undefined
}

export function ifCheckpointEntries(checkpoints: Record<string, any> | undefined, id: string): Array<{ uid: string, checkpoint: any }> {
  return Object.entries(checkpoints || {})
    .filter(([uid]) => uid === id || uid.startsWith(`${id}#`))
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([uid, checkpoint]) => ({ uid, checkpoint }))
}

export function buildRunOutline(items: OutlineItem[]): OutlineNode[] {
  const nodes = items.map(item => ({
    item,
    kind: item.step?.ifSpec || ['if', 'if_group'].includes(item.step?.nodeKind) ? 'if'
      : item.step?.reduceSpec || ['reduce', 'reduce_group'].includes(item.step?.nodeKind) ? 'reduce'
        : item.step?.isLoopGroup ? 'loop' : 'step',
    children: [], branches: [], skipped: false,
  } as OutlineNode))
  const byId = new Map<string, OutlineNode>()
  for (const node of nodes) {
    byId.set(node.item.value, node)
    if (node.item.step?.reduceId) byId.set(node.item.step.reduceId, node)
  }
  const candidates = new Map<OutlineNode, OutlineNode[]>()
  for (const node of nodes) {
    const step = node.item.step
    const owners = [byId.get(step?.ifBranch?.if), byId.get(step?.reduceBody?.reduce)]
    if (step?.inLoopGroup) owners.unshift(nodes.find(other => other.kind === 'loop' && other.item.step.loopGroupId === step.loopGroupId))
    for (const other of nodes) {
      if (other.kind === 'reduce' && other.item.step?.reduceSpec?.body?.includes(node.item.value)) owners.push(other)
    }
    candidates.set(node, [...new Set(owners.filter((owner): owner is OutlineNode => Boolean(owner && owner !== node)))])
  }
  const reaches = (start: OutlineNode, target: OutlineNode, seen = new Set<OutlineNode>()): boolean => {
    if (seen.has(start)) return false
    seen.add(start)
    return (candidates.get(start) || []).some(owner => owner === target || reaches(owner, target, seen))
  }
  const parents = new Map<OutlineNode, OutlineNode>()
  for (const node of nodes) {
    const owners = candidates.get(node) || []
    const owner = owners.find(candidate => !owners.some(other => other !== candidate && reaches(other, candidate))) || owners[0]
    if (owner && !reaches(owner, node)) parents.set(node, owner)
  }
  for (const node of nodes) {
    if (node.kind === 'if') node.branches = (['then', 'else'] as const).map(path => ({
      path, selected: node.item.step?.ifSelected ? node.item.step.ifSelected === path : undefined, children: [],
    }))
  }
  for (const node of nodes) {
    const parent = parents.get(node)
    if (!parent) continue
    if (parent.kind === 'if') {
      const branch = parent.branches.find(branch => branch.path === node.item.step?.ifBranch?.path)
      if (branch) branch.children.push(node)
      else parent.children.push(node)
    }
    else parent.children.push(node)
  }
  const roots = nodes.filter(node => !parents.has(node))
  const markSkipped = (node: OutlineNode, inherited: boolean) => {
    node.skipped = inherited || node.item.step?.ifBranchSelected === false || node.item.step?.status === 'skipped'
    for (const child of node.children) markSkipped(child, node.skipped)
    for (const branch of node.branches) for (const child of branch.children) markSkipped(child, node.skipped || branch.selected === false)
  }
  for (const root of roots) markSkipped(root, false)
  return roots
}