export function filterLocalWorkflowRefs(
  refs: string[],
  nodes: Record<string, unknown>,
): string[] {
  return refs.filter(ref => Boolean(nodes[ref]))
}