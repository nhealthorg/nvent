# analyze — example Python step (thin API)
#
# Demonstrates:
#   - define_function() with http() trigger helper
#   - Logger from iii-sdk
#   - iii state via trigger_async (or use iii.state helpers when available)
#
# Trigger: GET http://localhost:3111/analyze
#   Query: ?text=...

from nvent import define_function, http, ApiRequest, ApiResponse, Logger

logger = Logger("analyze")


async def handler(req: ApiRequest) -> ApiResponse:
    body = req.body or {}
    text = body.get("text", "") if isinstance(body, dict) else ""

    logger.info("analyze called", {"text_length": len(text)})

    words = text.split()
    unique = list({w.lower() for w in words})

    result = {
        "word_count": len(words),
        "char_count": len(text),
        "unique_words": len(unique),
    }

    logger.info("analyze complete", result)
    return ApiResponse(statusCode=200, body=result)


define_function(
    description="Analyzes text and returns word statistics",
    triggers=[http("GET", "/analyze")],
    handler=handler,
)

