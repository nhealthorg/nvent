# analyze — example Python step (motia-compatible format)
#
# Demonstrates:
#   - config dict with http() trigger helper
#   - ctx.logger            (iii Logger — OTel when available, else stdout)
#   - ctx.state.get/set     (persistent key-value state)
#   - ctx.enqueue()         (emit a message to a topic)
#
# Trigger: POST http://localhost:3111/analyze
#   Body: { "text": "..." }

from nvent import http, FlowContext, ApiRequest, ApiResponse

config = {
    "name": "analyze",
    "description": "Analyzes text and tracks invocation stats via iii state",
    "triggers": [http("GET", "/analyze")],
    "enqueues": [],
    "flows": ["text-processing"],
}


async def handler(req: ApiRequest, ctx: FlowContext) -> ApiResponse:
    # HTTP input arrives as ApiRequest — body holds the JSON payload
    body = req.body or {}
    text = body.get("text", "") if isinstance(body, dict) else ""

    ctx.logger.info("analyze called", {"text_length": len(text)})

    # --- state: track a running invocation counter ---
    try:
        raw = await ctx.state.get("item-0")
        count = (raw.get("value") or 0) if isinstance(raw, dict) else 0
    except Exception:
        count = 0

    count += 1
    await ctx.state.set("item-0", count)
    ctx.logger.debug(f"invocation_count is  now {count}")

    # --- compute stats ---
    words = text.split()
    unique = list(set(w.lower() for w in words))

    result = {
        "word_count": len(words),
        "char_count": len(text),
        "unique_words": len(unique),
        "invocation_count": count,
        "input": req
    }

    ctx.logger.info("analyze complete", result)
    return ApiResponse(statusCode=200, body=result)

