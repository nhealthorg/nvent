import { computed } from 'vue'
import { Position } from '@vue-flow/core'

export interface AwaitConfig {
  type: 'time' | 'event' | 'webhook'
  delay?: number
  event?: string
  method?: string
  timeout?: number
  timeoutAction?: 'fail' | 'continue'
}

export interface FlowEntry {
  step: string
  queue: string
  engineRetryMax?: number
  workerId: string
  runtime?: 'nodejs' | 'python'
  runtype?: 'inprocess' | 'task'
  emits?: string[]
  awaitBefore?: AwaitConfig
  awaitAfter?: AwaitConfig
  [key: string]: any
}
export interface FlowStep {
  queue: string
  engineRetryMax?: number
  workerId: string
  subscribes?: string[]
  runtime?: 'nodejs' | 'python'
  runtype?: 'inprocess' | 'task'
  emits?: string[]
  awaitBefore?: AwaitConfig
  awaitAfter?: AwaitConfig
  [key: string]: any
}

export type StepNodeStatus = 'idle' | 'running' | 'error' | 'done' | 'canceled'

export interface StepNodeData {
  label: string
  queue?: string
  engineRetryMax?: number
  workerId?: string
  status?: StepNodeStatus
  attempt?: number
  retries?: number
  error?: string
  runtime?: 'nodejs' | 'python'
  runtype?: 'inprocess' | 'task'
  subscribes?: string[]
  emits?: string[]
  stepTimeout?: number
  worker_name?: string
  pending_at?: number
  completed_at?: number
  [key: string]: any
}

export interface AwaitNodeData {
  label: string
  awaitType?: 'time' | 'event' | 'webhook'
  awaitConfig?: AwaitConfig
  status?: 'idle' | 'waiting' | 'resolved' | 'timeout'
  scheduledTriggerAt?: string
  awaitData?: any
  [key: string]: any
}

export interface FlowNode {
  id: string
  position: { x: number, y: number }
  data: StepNodeData | AwaitNodeData
  type?: string
  style?: Record<string, any>
  sourcePosition?: Position
  targetPosition?: Position
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  label?: string
  animated?: boolean
}

export function useFlowLayout(props: {
  flow: any
  stepStates: Record<string, any>
  flowStatus?: string
}) {
  const colWidth = 400
  const rowHeight = 240
  const horizontalGap = 160
  const verticalGap = 80
  const awaitColWidth = 200
  const nodeWidth = 320

  function mapStatusToNodeStatus(status?: string): StepNodeStatus {
    switch (status) {
      case 'running':
      case 'retrying':
      case 'waiting':
        return 'running'
      case 'completed':
        return 'done'
      case 'failed':
      case 'timeout':
      case 'stalled':
        return 'error'
      case 'canceled':
        return 'canceled'
      default:
        return 'idle'
    }
  }

  function estimateStepHeight(stepLike: any): number {
    if (stepLike?.isLoop || stepLike?.loopGroupId) return 180
    return 210
  }

  const nodes = computed<FlowNode[]>(() => {
    const out: FlowNode[] = []
    const f = props.flow
    if (!f) return out

    const states = props.stepStates || {}
    let x = 0

    // Entry node
    if (f.entry) {
      const entryState = states[f.entry.step]
      const status = mapStatusToNodeStatus(entryState?.status)
      const entryHeight = estimateStepHeight(f.entry)
      const entryStepTimeout = f.analyzed?.steps?.[f.entry.step]?.stepTimeout

      out.push({
        id: `entry:${f.entry.step}`,
        position: { x, y: 0 },
        data: {
          label: f.entry.step,
          queue: f.entry.queue,
          engineRetryMax: f.entry.engineRetryMax,
          workerId: f.entry.workerId,
          status,
          attempt: entryState?.attempt,
          retries: entryState?.retries,
          error: entryState?.error,
          runtime: f.entry.runtime,
          runtype: f.entry.runtype,
          emits: f.entry.emits,
          awaitBefore: f.entry.awaitBefore,
          awaitAfter: f.entry.awaitAfter,
          stepTimeout: entryStepTimeout,
          worker_name: entryState?.worker_name,
          pending_at: entryState?.pending_at,
          completed_at: entryState?.completed_at,
          isLoop: f.entry.isLoop,
          loopOver: f.entry.loopOver,
          loopMode: f.entry.loopMode,
          __nodeHeight: entryHeight,
        },
        type: 'flow-entry',
        style: { minWidth: `${nodeWidth}px`, zIndex: 20 },
        sourcePosition: Position.Right,
      })
      x += colWidth + horizontalGap

      if (f.entry.awaitAfter) {
        const waitKey = `${f.entry.step}:await-after`
        const s = states[waitKey]
        const awaitStatus = s?.status === 'waiting' ? 'waiting' : s?.status === 'completed' ? 'resolved' : s?.status === 'timeout' ? 'timeout' : 'idle'

        out.push({
          id: `await:entry-after:${f.entry.step}`,
          position: { x, y: 35 },
          data: {
            label: `Await (${f.entry.awaitAfter.type})`,
            awaitType: f.entry.awaitAfter.type,
            awaitConfig: f.entry.awaitAfter,
            status: awaitStatus,
            scheduledTriggerAt: s?.scheduledTriggerAt,
          },
          type: 'flow-await',
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        })
        x += awaitColWidth + horizontalGap
      }
    }

    const steps = f.steps || {}
    if (f.analyzed?.levels) {
      const startLevel = f.entry ? 1 : 0
      const levels = f.analyzed.levels.slice(startLevel).filter((l: string[]) => l.length > 0)

      levels.forEach((levelSteps: string[]) => {
        const hasAwait = levelSteps.some(name => steps[name]?.awaitBefore)
        if (hasAwait) {
          levelSteps.forEach(name => {
            const step = steps[name]
            if (!step?.awaitBefore) return
            const s = states[`${name}:await-before`]
            out.push({
              id: `await:step-before:${name}`,
              position: { x, y: 0 },
              data: { label: `Await`, awaitType: step.awaitBefore.type, status: s?.status === 'waiting' ? 'waiting' : 'idle' },
              type: 'flow-await',
              sourcePosition: Position.Right,
              targetPosition: Position.Left,
            })
          })
          x += awaitColWidth + horizontalGap
        }

        const rowsCount = Math.min(4, levelSteps.length)
        const colsInLevel = Math.ceil(levelSteps.length / rowsCount)
        const levelHeight = rowsCount * rowHeight + (rowsCount - 1) * verticalGap
        const levelStartY = -levelHeight / 2

        levelSteps.forEach((name, idx) => {
          const step = steps[name]
          const s = states[name]
          const colIdx = Math.floor(idx / rowsCount)
          const rowIdx = idx % rowsCount

          const xPos = x + colIdx * (colWidth + horizontalGap)
          const yPos = levelStartY + rowIdx * (rowHeight + verticalGap)
          const nodeHeight = estimateStepHeight(step)

          out.push({
            id: `step:${name}`,
            position: { x: xPos, y: yPos },
            data: {
              label: name,
              status: mapStatusToNodeStatus(s?.status),
              queue: step?.queue,
              workerId: step?.workerId,
              attempt: s?.attempt,
              error: s?.error,
              __nodeHeight: nodeHeight,
              ...step,
            },
            type: 'flow-step',
            style: { minWidth: `${nodeWidth}px`, zIndex: 20 },
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
          })

          if (step?.awaitBefore) {
            const waitNode = out.find(n => n.id === `await:step-before:${name}`)
            if (waitNode) {
              waitNode.position.x = xPos - (awaitColWidth + horizontalGap)
              waitNode.position.y = yPos + (nodeHeight / 2) - 40
            }
          }

          // Add await column after step if it has awaitAfter
          if (step?.awaitAfter) {
             const awaitKey = `${name}:await-after`
             const awaitState = states[awaitKey]
             const awaitStatus = awaitState?.status === 'waiting' ? 'waiting' : awaitState?.status === 'completed' ? 'resolved' : awaitState?.status === 'timeout' ? 'timeout' : 'idle'

             out.push({
               id: `await:step-after:${name}`,
               position: { x: xPos + colWidth + (horizontalGap/2), y: yPos + (nodeHeight / 2) - 40 },
               data: {
                 label: `Await (${step.awaitAfter.type})`,
                 awaitType: step.awaitAfter.type,
                 awaitConfig: step.awaitAfter,
                 status: awaitStatus,
               },
               type: 'flow-await',
               sourcePosition: Position.Right,
               targetPosition: Position.Left,
             })
          }
        })
        x += colsInLevel * (colWidth + horizontalGap)
      })
    }

    const loopGroups = Array.isArray(f.loopGroups) ? f.loopGroups : []
    for (const lg of loopGroups) {
      const members = out.filter(n => n.id.startsWith('step:') && lg.nodeIds.includes(n.id.replace('step:', '')))
      if (!members.length) continue
      const minX = Math.min(...members.map(n => n.position.x))
      const maxX = Math.max(...members.map(n => n.position.x + nodeWidth))
      const minY = Math.min(...members.map(n => n.position.y))
      const maxY = Math.max(...members.map(n => n.position.y + ((n.data as any)?.__nodeHeight || 210)))

      out.unshift({
        id: `loop-group:${lg.id}`,
        position: { x: minX - 40, y: minY - 50 },
        data: { title: lg.id, over: lg.over, mode: lg.mode } as any,
        type: 'flow-loop-group',
        style: { width: `${maxX - minX + 80}px`, height: `${maxY - minY + 100}px`, zIndex: 1, pointerEvents: 'none' },
      })
    }

    return out
  })

  const edges = computed<FlowEdge[]>(() => {
    const f = props.flow
    if (!f) return []
    const states = props.stepStates || {}
    const steps = f.steps || {}

    const added = new Set<string>()
    const out: FlowEdge[] = []

    function addEdge(source: string, target: string, label?: string) {
      const id = `${source}->${target}${label ? `:${label}` : ''}`
      if (added.has(id)) return

      const getNodeState = (nodeId: string) => {
        if (nodeId.startsWith('await:entry-after:')) {
          const stepName = nodeId.replace('await:entry-after:', '')
          return states[`${stepName}:await-after`]
        }
        if (nodeId.startsWith('await:step-before:')) {
          const stepName = nodeId.replace('await:step-before:', '')
          return states[`${stepName}:await-before`]
        }
        if (nodeId.startsWith('await:step-after:')) {
          const stepName = nodeId.replace('await:step-after:', '')
          return states[`${stepName}:await-after`]
        }
        const parts = nodeId.split(':')
        return parts[1] ? states[parts[1]] : undefined
      }

      const sourceState = getNodeState(source)
      const targetState = getNodeState(target)

      const shouldAnimate = (props.flowStatus === 'running' || props.flowStatus === 'awaiting')
        && (sourceState?.status === 'completed' || sourceState?.status === 'resolved')
        && (targetState?.status === 'running' || targetState?.status === 'pending' || targetState?.status === 'waiting' || !targetState)

      added.add(id)
      out.push({ id, source, target, label, animated: shouldAnimate })
    }

    if (f.analyzed?.steps) {
      const analyzedSteps = f.analyzed.steps

      if (f.entry?.awaitAfter) {
        addEdge(`entry:${f.entry.step}`, `await:entry-after:${f.entry.step}`)
      }

      for (const [stepName, stepInfo] of Object.entries(analyzedSteps) as [string, any][]) {
        if (stepName === f.entry?.step) continue

        const targetStep = steps[stepName]
        const target = `step:${stepName}`

        if (targetStep?.awaitAfter) {
          addEdge(`step:${stepName}`, `await:step-after:${stepName}`)
        }

        if (stepInfo.dependsOn.length > 0) {
          for (const depName of stepInfo.dependsOn) {
            let source: string
            if (depName === f.entry?.step) {
              source = f.entry.awaitAfter ? `await:entry-after:${depName}` : `entry:${depName}`
            } else {
              const depStep = steps[depName]
              source = depStep?.awaitAfter ? `await:step-after:${depName}` : `step:${depName}`
            }

            if (targetStep?.awaitBefore) {
              const awaitNodeId = `await:step-before:${stepName}`
              addEdge(source, awaitNodeId)
              addEdge(awaitNodeId, target)
            } else {
              addEdge(source, target)
            }
          }
        }
      }
    }

    return out
  })

  return {
    nodes,
    edges,
    mapStatusToNodeStatus
  }
}
