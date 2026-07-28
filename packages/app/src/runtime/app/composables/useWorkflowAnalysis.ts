import { computed } from '#imports'

export interface WorkflowNodeDefinition {
  depends_on?: string[]
  function: {
    id: string
    runtime: string
    queue?: string
    engine_retry?: {
      max_attempts?: number
    }
  }
}

export interface WorkflowDefinition {
  nodes: Record<string, WorkflowNodeDefinition>
}

export interface AnalyzedStep {
  name: string
  dependsOn: string[]
  level: number
}

/**
 * Composable for workflow definition analysis and node leveling
 */
export function useWorkflowAnalysis() {
  /**
   * Analysis of workflow nodes to determine execution levels (topological sort)
   */
  function analyzeWorkflow(nodes: Record<string, WorkflowNodeDefinition>) {
    const steps: Record<string, { name: string, dependsOn: string[] }> = {}
    
    Object.entries(nodes).forEach(([id, node]) => {
      steps[id] = {
        name: id,
        dependsOn: node.depends_on || []
      }
    })

    const levels: string[][] = []
    const placed = new Set<string>()
    const analyzedSteps: Record<string, AnalyzedStep> = {}
    
    while (placed.size < Object.keys(steps).length) {
      const currentLevel: string[] = []
      for (const id in steps) {
        if (placed.has(id)) continue
        const step = steps[id]
        if (!step) continue
        const deps = step.dependsOn
        if (deps.length === 0 || deps.every(d => placed.has(d))) {
          currentLevel.push(id)
        }
      }
      
      if (currentLevel.length === 0) {
        // Handle cycles by picking one node that isn't placed yet 
        // to break the cycle and start a new level.
        const remaining = Object.keys(steps).filter(id => !placed.has(id))
        if (remaining.length > 0) {
          // Find node with fewest UNPLACED dependencies
          let bestId = remaining[0]
          let minUnplaced = Infinity
          
          for (const id of remaining) {
            const unplacedDeps = steps[id].dependsOn.filter(d => !placed.has(d)).length
            if (unplacedDeps < minUnplaced) {
              minUnplaced = unplacedDeps
              bestId = id
            }
          }
          currentLevel.push(bestId)
        } else {
          break
        }
      }
      
      levels.push(currentLevel)
      currentLevel.forEach(id => {
        placed.add(id)
        analyzedSteps[id] = {
          name: id,
          dependsOn: steps[id].dependsOn,
          level: levels.length - 1
        }
      })
    }

    return {
      levels,
      steps: analyzedSteps,
      maxLevel: levels.length
    }
  }

  /**
   * Returns a sorted list of node IDs based on their execution level
   */
  function sortNodesByLevel(nodes: Record<string, WorkflowNodeDefinition>): string[] {
    const { levels } = analyzeWorkflow(nodes)
    return levels.flat()
  }

  return {
    analyzeWorkflow,
    sortNodesByLevel
  }
}
