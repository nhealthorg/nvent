"""
pipeline_analyze.py — Python step for the pipeline flow.

Triggered by the 'pipeline.analyze' queue message emitted by pipeline.ts.
Because the queue message carries the OTel traceparent automatically, this
step runs inside the same trace as the HTTP entry step.  That means
``ctx.stream.set(item_id, data)`` writes to the *exact same* WebSocket
channel (stream='pipeline', group=traceId) without any extra coordination.

The client subscribes once after the HTTP call and receives updates from
both Node.js and Python steps in real order.
"""
import asyncio
from nvent import queue, FlowContext

config = {
    "name": "pipeline::analyze",
    "description": "Analyse text and publish progress to the shared stream channel",
    "triggers": [queue("pipeline.analyze")],
    "flows": ["pipeline"],
    # 'stream' defaults to flows[0] = 'pipeline', so no need to set it explicitly.
}


async def handler(data: dict, ctx: FlowContext) -> None:
    text: str = data.get("text", "")
    words = text.split()

    steps = [
        ("Tokenizing text",      lambda: {"tokens": words}),
        ("Counting words",       lambda: {"wordCount": len(words)}),
        ("Finding unique words", lambda: {"uniqueWords": list({w.lower() for w in words})}),
        ("Computing statistics", lambda: _stats(text, words)),
    ]
    total = len(steps)

    for i, (label, compute) in enumerate(steps):
        await asyncio.sleep(0.6)  # simulate work
        # set() uses stream='pipeline' + group=ctx.trace_id — no args needed!
        await ctx.stream.set(f"step-{i + 1}", {
            "step": i + 1,
            "total": total,
            "label": label,
            "data": compute(),
            "worker": "python",   # useful for demo: shows which runtime handled it
        })

    stats = _stats(text, words)
    await ctx.stream.set("result", {"done": True, **stats})


def _stats(text: str, words: list[str]) -> dict:
    unique = {w.lower() for w in words}
    avg_len = round(sum(len(w) for w in words) / len(words), 2) if words else 0
    longest = max(words, key=len, default="")
    return {
        "wordCount": len(words),
        "uniqueWordCount": len(unique),
        "charCount": len(text),
        "avgWordLength": avg_len,
        "longestWord": longest,
    }
