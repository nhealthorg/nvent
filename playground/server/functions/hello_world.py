from nvent import define_function, http, ApiRequest, ApiResponse, Logger

logger = Logger("hello_world")

async def handler(req: ApiRequest) -> ApiResponse:
    name = req.query_params.get("name", "World")
    greeting = f"Hello, {name}!"
    logger.info("Generated greeting", {"greeting": greeting})
    return ApiResponse(status_code=200, body={"greeting": greeting})

define_function(
    description="A simple function that greets the user by name",
    triggers=[http("GET", "/hello/python")],
    handler=handler,
)