import asyncio
from nvent import define_function, Logger

logger = Logger("wait")

async def handler(input_data: dict):
    # Support both "seconds" and "wait" keys to be flexible with workflow inputs
    seconds = input_data.get("seconds") or input_data.get("wait") or 10
    logger.info(f"Waiting for {seconds} seconds...")
    
    # Non-blocking wait using asyncio
    await asyncio.sleep(seconds)
    
    logger.info("Wait completed")
    return {"waited_for": seconds, "status": "done"}

define_function(
    description="A simple function that waits for a specified number of seconds",
    handler=handler,
    workflow=True,
    request_format={"type": "object", "properties": {"seconds": {"type": "number"}}},
    response_format={"type": "object", "properties": {"waited_for": {"type": "number"}, "status": {"type": "string"}}},
)