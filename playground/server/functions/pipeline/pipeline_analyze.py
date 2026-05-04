"""
pipeline_analyze.py — Python step for the pipeline flow.

Triggered by the 'pipeline.analyze' durable:subscriber queue message emitted
by pipeline.ts, which includes `streamName` and `groupId` in the payload so
this step can write progress events to the same WebSocket stream channel as
the Node.js steps.
"""
import asyncio
from nvent import queue, FlowContext

config = {
    "name": "pipeline::analyze",
    "description": "Analyse text and publish progress to the shared stream channel",
    "triggers": [queue("pipeline.analyze")],
}


async def handler(data: dict, ctx: FlowContext) -> None:
    text: str = data.get("text", "")
    stream_name: str = data.get("streamName", "pipeline")
    group_id: str = data.get("groupId", "")
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
        await ctx.stream.set_in(stream_name, group_id, f"step-{i + 1}", {
            "step": i + 1,
            "total": total,
            "label": label,
            "data": compute(),
            "worker": "python",
        })

    stats = _stats(text, words)
    await ctx.stream.set_in(stream_name, group_id, "result", {"done": True, **stats})


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
