"""
analyze.py — Text analysis function for workflows.

This function analyzes text and returns detailed statistics.
Designed to be called from workflows via the function executor.

Input: { text: string }
Output: { wordCount, charCount, uniqueWords, avgWordLength, longestWord, uniqueWordsList }
"""
from nvent import define_function, Logger

logger = Logger("pipeline::analyze")


async def handler(input: dict) -> dict:
    """Analyze text and return statistics."""
    text: str = input.get("text", "")
    
    if not text:
        logger.warn("Empty text provided")
        return {
            "wordCount": 0,
            "charCount": 0,
            "uniqueWords": 0,
            "avgWordLength": 0,
            "longestWord": "",
        }
    
    words = text.split()
    filtered_words = [w for w in words if w.strip()]
    unique_words = list({w.lower() for w in filtered_words})
    
    logger.info("Analyzing text", {"wordCount": len(filtered_words)})
    
    avg_length = (
        round(sum(len(w) for w in filtered_words) / len(filtered_words), 2)
        if filtered_words
        else 0
    )
    longest = max(filtered_words, key=len, default="")
    
    result = {
        "wordCount": len(filtered_words),
        "charCount": len(text),
        "uniqueWords": len(unique_words),
        "avgWordLength": avg_length,
        "longestWord": longest,
        "uniqueWordsList": unique_words[:10],  # First 10 unique words
    }
    
    logger.info("Text analysis complete", result)
    return result


define_function(
    description="Analyzes text and returns detailed word statistics",
    handler=handler,
)
