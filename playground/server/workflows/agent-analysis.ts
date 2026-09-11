import { defineWorkflow } from '#nvent/server'

/**
 * Agent-driven Analysis & Action Plan Workflow
 * 
 * Demonstrates nworkflow + harness agent integration:
 * 1. Preprocesses input text using a standard function node.
 * 2. Uses an Agent (Analyst) to extract key findings and sentiment.
 * 3. Uses an Agent (Planner) to generate a prioritized action plan from the analysis.
 * 
 * Example invocation:
 *   await iii.trigger({
 *     function_id: 'agent-analysis',
 *     payload: { text: 'Our customer support response times increased by 40% last week due to new software rollout.' }
 *   })
 */
export default defineWorkflow({
  name: 'agent-analysis',
  description: 'Multi-stage workflow pairing function processing with harness AI agents',
  request_format: {
    text: {
      type: 'string',
      description: 'The raw report or text to analyze',
      default: 'Customer support response times increased by 40% following the v2.0 release.'
    }
  },
  handler: async (input: { text: string }, ctx) => {
    // 1. Preprocess raw text using a standard workflow function node
    const processed = await ctx.call('process-text', input)

    // 2. Stage 1: AI Analyst Agent
    const analysis = await ctx.agent({
      prompt: 'Analyze the processed report text. Identify the core problem, key metrics, and sentiment.',
      input: processed,
      agent: {
        id: 'analyst',
        display: {
          name: 'Insight Analyst',
          icon: 'search',
          color: 'teal'
        }
      },
      task: {
        title: 'Analyze Report Findings'
      }
    }, {
      model: 'google/Gemma3-4B/gemma-3-4b-it-Q8_0.gguf',
      maxTurns: 5,
      stream: {
        enabled: false
      },
      systemPromptStrategy: 'override',
      systemPrompt: 'You are an expert business analyst specializing in operational reporting. Please provide a detailed analysis of the report text, highlighting the core problem, key metrics, and overall sentiment. Return as json with the following structure: { "coreProblem": string, "keyMetrics": Record<string, any>, "sentiment": string }',
      result: {
        returnType: 'memory'
      }
    })

    // 3. Stage 2: AI Action Planner Agent (chained with analyst output)
    const actionPlan = await ctx.agent({
      prompt: 'Based on the analysis findings, propose a prioritized 3-step action plan to mitigate the issues.',
      input: analysis,
      agent: {
        id: 'planner',
        display: {
          name: 'Action Planner',
          icon: 'design',
          color: 'purple'
        }
      },
      task: {
        title: 'Generate Action Plan'
      }
    }, {
      model: 'google/Gemma3-4B/gemma-3-4b-it-Q8_0.gguf',
      maxTurns: 5,
      stream: {
        enabled: false
      },
      systemPromptStrategy: 'override',
      systemPrompt: 'You are a pragmatic project manager creating clear, actionable mitigation steps. Return as json with the following structure: type ActionPlan = { "description": string, "owner": string, "dueDate": string } { "steps": ActionPlan[] }',
      result: {
        returnType: 'memory'
      }
    })

    return {
      processed,
      analysis,
      actionPlan
    }
  }
})
