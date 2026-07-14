import { defineFunction } from '#nvent/server'

/**
 * Enhanced text analysis function - works with plain data objects
 * 
 * Input: { text: string } or { original: string, ... } (from process-text output)
 * Output: { wordCount, charCount, uniqueWords, avgWordLength, longestWord }
 */
export default defineFunction({
  description: 'Analyzes text and returns detailed statistics',
  handler: async (input: any) => {
    // Handle both direct text input and processed text input
    const text = input?.text || input?.original || ''
    
    // wait for 5 seconds to simulate a long-running process
    await new Promise(resolve => setTimeout(resolve, 5000))
    
    const words = text.split(/\s+/).filter((w: string) => w.length > 0)
    const uniqueWords = [...new Set(words.map((w: string) => w.toLowerCase()))]
    const avgWordLength = words.length > 0
      ? Math.round((words.reduce((sum: number, w: string) => sum + w.length, 0) / words.length) * 100) / 100
      : 0
    const longestWord = words.reduce((longest: string, word: string) => 
      word.length > longest.length ? word : longest, '')
    
    return {
      wordCount: words.length,
      charCount: text.length,
      uniqueWords: uniqueWords.length,
      avgWordLength,
      longestWord,
      sampleWords: uniqueWords.slice(0, 10)
    }
  }
})
