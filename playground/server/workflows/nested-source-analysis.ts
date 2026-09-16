import { defineWorkflow } from '#nvent/server'

const DEFAULT_SOURCE = {
  title: 'Demo research source',
  url: 'https://example.org/demo-research-source',
  content: 'Replace this demo excerpt with the approved source text to analyze.',
}

const DEFAULT_TOPIC = 'What are the most important findings in this source?'

export default defineWorkflow({
  name: 'nested-source-analysis',
  description: 'Analyzes one research source with an agent',
  request_format: {
    source: {
      type: 'object',
      description: 'A source with a title, URL, and content to analyze',
    },
    topic: {
      type: 'string',
      description: 'The research question this source should answer',
    },
  },
  handler: async (input: {
    source?: {
      title: string
      url: string
      content: string
    }
    topic?: string
  }, ctx) => {
        const rawSource = input?.source
        const source = rawSource && typeof rawSource === 'object' && typeof rawSource.title === 'string' && rawSource.title
          ? rawSource
          : DEFAULT_SOURCE
        const topic = typeof input?.topic === 'string' && input.topic ? input.topic : DEFAULT_TOPIC

        const result = await ctx.agent({
            prompt: `Analyze this source in the context of the research question: ${topic}`,
            input: source,
            agent: {
                id: 'source-analyst',
                display: {
                    name: 'Source Analyst',
                    icon: 'search',
                    color: 'teal',
                },
            },
            task: {
              title: `Analyze ${source.title}`,
            },
            }, {
            model: 'google/Gemma3-4B/gemma-3-4b-it-Q8_0.gguf',
            maxTurns: 6,
            stream: {
                enabled: true,
            },
            systemPromptStrategy: 'override',
            systemPrompt: 'You are a careful research analyst. Extract the strongest claims, supporting evidence, contradictions, risks of bias, and a confidence score from the source. Do not invent facts. Return JSON with this shape: { "sourceTitle": string, "claims": string[], "evidence": string[], "contradictions": string[], "biasRisks": string[], "confidence": number }',
            result: {
                returnType: 'memory',
            },
            })
        return result
  },
})
