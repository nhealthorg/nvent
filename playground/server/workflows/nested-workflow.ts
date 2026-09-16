import { defineWorkflow } from '#nvent/server'

type ResearchSource = {
	title: string
	url: string
	content: string
}

const DEFAULT_SOURCES: ResearchSource[] = [
	{
		title: 'WHO healthy ageing overview',
		url: 'https://www.who.int/initiatives/decade-of-healthy-ageing',
		content: 'Replace this demo text with an approved source excerpt before using the workflow in production.',
	},
	{
		title: 'Local mobility program report',
		url: 'https://example.org/mobility-program-report',
		content: 'Replace this demo text with a second source excerpt from the same research topic.',
	},
	{
		title: 'Clinical intervention review',
		url: 'https://example.org/clinical-intervention-review',
		content: 'Replace this demo text with a review or guideline that should be compared with the other sources.',
	},
]

/**
 * Parent workflow: fan out one nested workflow per source, then synthesize the findings.
 * Each call to nested-source-analysis creates a separate child run with its own stream.
 */
export default defineWorkflow({
	name: 'nested-workflow',
	description: 'Compare multiple sources with nested agentic analyses and synthesize the result',
	request_format: {
		topic: {
			type: 'string',
			description: 'The research question to investigate',
			default: 'Which interventions appear most promising for improving mobility in older adults?',
		},
	},
	handler: async (input: { topic: string }, ctx) => {

        // ctx.loop requires a node reference (not a plain literal array), so
        // register the source list as a workflow variable first.
        const sources = await ctx.var('sources', DEFAULT_SOURCES)

        const sourceAnalyses  = await ctx.loop(sources, async loop => {
            const result = await loop.callWorkflow(
			'nested-source-analysis',
			{
				topic: input.topic,
				source: loop.item,
			},
			{
				label: 'Analyze source',
				result: {
					returnType: 'memory',
				},
			})
            return result
        }, {
			mode: 'batch',
			batchSize: 2,
		})

		const synthesis = await ctx.agent({
			prompt: `Synthesize the source analyses into a decision-ready answer to: ${input.topic}`,
			input: sourceAnalyses,
			agent: {
				id: 'research-synthesizer',
				display: {
					name: 'Research Synthesizer',
					icon: 'review',
					color: 'purple',
				},
			},
			task: {
				title: 'Synthesize research findings',
			},
		}, {
			model: 'google/Gemma3-4B/gemma-3-4b-it-Q8_0.gguf',
			maxTurns: 6,
			stream: {
				enabled: true,
			},
			systemPromptStrategy: 'override',
			systemPrompt: 'You are a rigorous evidence synthesizer. Compare the source findings, separate consensus from disagreement, cite source titles, and state important limitations. Return JSON with this shape: { "answer": string, "consensus": string[], "disagreements": string[], "recommendedNextSteps": string[], "limitations": string[] }',
			result: {
				returnType: 'memory',
			},
		})

		return {
			topic: input.topic,
			sourceCount: DEFAULT_SOURCES.length,
			sourceAnalyses,
			synthesis,
		}
	},
})
