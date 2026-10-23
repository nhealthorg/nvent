import { describe, expect, it } from 'vitest'
import { buildRunOutline, ifBranchSelection, ifCheckpointEntries, ifCheckpointFor } from '../src/runtime/app/components/flow/run-outline'

const item = (value: string, step: Record<string, any> = {}) => ({ value, label: value, step })

describe('run outline', () => {
  it('preserves mixed nesting, order, keys and inherited skipped state without mutating inputs', () => {
    const items = [
      item('outer', { ifSpec: {}, ifSelected: 'else' }),
      item('reduce-group:sum', { reduceId: 'sum', reduceSpec: { body: ['inner', 'leaf'] }, ifBranch: { if: 'outer', path: 'then' } }),
      item('inner', { ifSpec: {}, ifSelected: 'then', reduceBody: { reduce: 'sum' }, ifBranch: { if: 'outer', path: 'then' } }),
      item('leaf', { reduceBody: { reduce: 'sum' }, ifBranch: { if: 'inner', path: 'then' } }),
      item('other', { ifBranch: { if: 'outer', path: 'else' } }),
    ]
    const before = JSON.stringify(items)
    const tree = buildRunOutline(items)
    expect(tree).toHaveLength(1)
    const reduce = tree[0]!.branches[0]!.children[0]!
    expect(reduce.kind).toBe('reduce')
    expect(reduce.children.map(node => node.item.value)).toEqual(['inner'])
    const leaf = reduce.children[0]!.branches[0]!.children[0]!
    expect(leaf.item.value).toBe('leaf')
    expect(leaf.skipped).toBe(true)
    expect(tree[0]!.branches[1]!.children[0]!.skipped).toBe(false)
    expect(JSON.stringify(items)).toBe(before)
  })

  it('keeps missing owners and cyclic metadata visible and pending branches undecided', () => {
    const tree = buildRunOutline([
      item('a', { ifSpec: {}, ifBranch: { if: 'b', path: 'then' } }),
      item('b', { ifSpec: {}, ifBranch: { if: 'a', path: 'else' } }),
      item('orphan', { reduceBody: { reduce: 'missing' } }),
    ])
    expect(tree).toHaveLength(3)
    expect(tree[0]!.branches[0]!.selected).toBeUndefined()
  })

  it('uses exact iteration decisions, never another iteration or a template decision', () => {
    const checkpoints = { condition: { selected: 'then' }, 'condition#0': { selected: 'else' }, 'condition#1': { selected: 'then' } }
    expect(ifCheckpointFor(checkpoints, 'condition', 'body#0')?.selected).toBe('else')
    expect(ifCheckpointFor(checkpoints, 'condition#0')?.selected).toBe('else')
    expect(ifBranchSelection(checkpoints, { if: 'condition', path: 'then' }, 'body#0')).toBe(false)
    expect(ifBranchSelection(checkpoints, { if: 'condition', path: 'then' }, 'body#1')).toBe(true)
    expect(ifBranchSelection(checkpoints, { if: 'condition', path: 'then' }, 'body#2')).toBeUndefined()
    expect(ifBranchSelection(undefined, { if: 'condition', path: 'then' })).toBeUndefined()
    expect(ifCheckpointEntries({ 'if#10': {}, 'if#2': {}, 'different#0': {} }, 'if').map(entry => entry.uid)).toEqual(['if#2', 'if#10'])
  })

  it('keeps loop children inside their nearest control owner exactly once', () => {
    const tree = buildRunOutline([
      item('if', { ifSpec: {}, ifSelected: 'then' }),
      item('loop', { isLoopGroup: true, loopGroupId: 'group', ifBranch: { if: 'if', path: 'then' } }),
      item('child', { inLoopGroup: true, loopGroupId: 'group', ifBranch: { if: 'if', path: 'then' } }),
    ])
    expect(tree).toHaveLength(1)
    const loop = tree[0]!.branches[0]!.children[0]!
    expect(loop.kind).toBe('loop')
    expect(loop.children.map(child => child.item.value)).toEqual(['child'])
    expect(tree[0]!.branches[0]!.children).toHaveLength(1)
  })

  it('supports repeated if/reduce nesting without a fixed depth', () => {
    const items = [item('root', { ifSpec: {} })]
    for (let index = 0; index < 30; index++) {
      items.push(item(`reduce-${index}`, { reduceSpec: { body: [`if-${index}`] }, ifBranch: { if: index ? `if-${index - 1}` : 'root', path: 'then' } }))
      items.push(item(`if-${index}`, { ifSpec: {}, reduceBody: { reduce: `reduce-${index}` } }))
    }
    let node = buildRunOutline(items)[0]!
    for (let index = 0; index < 30; index++) {
      node = node.branches[0]!.children[0]!
      expect(node.item.value).toBe(`reduce-${index}`)
      node = node.children[0]!
      expect(node.item.value).toBe(`if-${index}`)
    }
  })
})