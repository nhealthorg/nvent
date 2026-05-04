# nvent — Python helpers for step files
#
# This file is written to two places by the nvent Nuxt module:
#   1. The venv's site-packages/   → for VS Code / Pylance import resolution
#   2. .nuxt/iii-workers/nvent.py  → overrides at runtime (imports real FlowContext from _runtime)
#
# Structure: all stubs are defined unconditionally so Pylance always resolves
# them with full types. At the bottom, a try/except overwrites the names at
# runtime (inside a worker process) without confusing static analysis.

from __future__ import annotations
from typing import Any, Callable, Coroutine, Optional, Union

# ── Type aliases ───────────────────────────────────────────────────────────

#: Any async or sync callable accepted as a nvent handler.
NventHandler = Callable[..., Union[Coroutine[Any, Any, Any], Any]]


# ── Trigger helpers ────────────────────────────────────────────────────────

def http(method: str, path: str) -> dict:
    """HTTP trigger: ``http("POST", "/my-endpoint")``"""
    return {"type": "http", "method": method.upper(), "path": path}


def queue(topic: str) -> dict:
    """Queue (durable:subscriber) trigger: ``queue("order.created")``"""
    return {"type": "durable:subscriber", "topic": topic}


def cron(expression: str) -> dict:
    """Cron trigger: ``cron("0 0 * * * * *")``  (7-field: sec min hour dom month dow year)"""
    return {"type": "cron", "expression": expression}


# ── Request / Response ─────────────────────────────────────────────────────

class ApiRequest:
    """HTTP request input for http-triggered Python functions.

    The iii SDK uses snake_case field names:
      req.headers       — dict[str, str]
      req.method        — 'GET' | 'POST' | ...
      req.path_params   — dict[str, str]
      req.query_params  — dict[str, str]
      req.body          — parsed body (dict/list/str), or None for GET/HEAD
    """
    headers: dict[str, str]
    method: str
    path_params: dict[str, str]
    query_params: dict[str, str]
    body: Optional[Any]


class ApiResponse:
    """HTTP response returned from an http-triggered handler.

    Example::

        return ApiResponse(statusCode=200, body={"ok": True})
        return ApiResponse(statusCode=201, body=result, headers={"x-request-id": rid})
    """
    def __init__(
        self,
        *,
        statusCode: int = 200,
        body: Any = None,
        headers: dict[str, str] = None,
    ) -> None: ...


# ── Stream ─────────────────────────────────────────────────────────────────

class IStream:
    """Access to the iii Stream module.

    **Implicit API** (recommended): ``set(item_id, data)`` uses the function's
    flow name as the stream name and the current trace ID as the group ID.
    All steps in the same request chain share the same trace → same channel.

    **Explicit API**: ``set_in(name, group, item_id, data)`` targets any stream.

    Example — implicit (most common)::

        # Returns subscription info for the HTTP client:
        return ApiResponse(statusCode=200, body=ctx.stream.subscription())

        # Any step in the same trace writes here — no groupId needed:
        await ctx.stream.set("step-1", {"step": 1, "total": 4, "label": "Tokenizing"})
        await ctx.stream.send({"type": "done"})

    Example — explicit (cross-flow or custom group)::

        await ctx.stream.set_in("other-flow", "group-abc", "item-1", data)
    """

    async def set(self, item_id: str, data: dict) -> None:
        """Set (create/update) an item in the implicit stream channel (flow + traceId)."""
        ...

    async def send(self, data: dict) -> None:
        """Send a custom event to all subscribers of the implicit stream channel."""
        ...

    def subscription(self) -> dict:
        """Return ``{"streamName": ..., "groupId": ...}`` for the implicit channel.
        Return this from an HTTP handler for the client to subscribe.
        """
        ...

    async def set_in(self, name: str, group: str, item_id: str, data: dict) -> None:
        """Set (create/update) an item in an explicit stream group."""
        ...

    async def get_item(self, name: str, group: str, item_id: str) -> dict:
        """Get a single item from a stream group."""
        ...

    async def delete_item(self, name: str, group: str, item_id: str) -> None:
        """Delete an item from a stream group."""
        ...

    async def list_items(self, name: str, group: str) -> list:
        """List all items in a stream group."""
        ...

    async def send_to(self, name: str, group: str, data: dict) -> None:
        """Send a custom event to all subscribers of an explicit stream group."""
        ...


# ── Logger / State ─────────────────────────────────────────────────────────

class ILogger:
    """Structured logger available as ``ctx.logger``."""
    def info(self, msg: str, data: Any = None) -> None: ...
    def warn(self, msg: str, data: Any = None) -> None: ...
    def error(self, msg: str, data: Any = None) -> None: ...
    def debug(self, msg: str, data: Any = None) -> None: ...
    def trace(self, msg: str, data: Any = None) -> None: ...


class IState:
    """Key-value state store available as ``ctx.state``.
    Scope is automatically bound to the function ID.
    """

    async def get(self, key: str) -> Any:
        """Read a value. Returns None if not set."""
        ...

    async def set(self, key: str, value: Any) -> None:
        """Write a value."""
        ...

    async def delete(self, key: str) -> None:
        """Delete a key."""
        ...

    async def list(self) -> list:
        """List all keys in this function's scope."""
        ...


class Logger:
    """Structured logger — backed by iii-sdk's Logger in worker context.

    Usage::

        from nvent import Logger
        logger = Logger("my-function")
        logger.info("hello", {"key": "value"})
    """
    def __init__(self, name: str = "") -> None: ...
    def info(self, message: str, data: dict = None) -> None: ...
    def warn(self, message: str, data: dict = None) -> None: ...
    def error(self, message: str, data: dict = None) -> None: ...
    def debug(self, message: str, data: dict = None) -> None: ...


# ── FlowContext ────────────────────────────────────────────────────────────

class FlowContext:
    """Execution context passed as the second argument to every handler.

    Example — HTTP step that streams results::

        async def handler(req: ApiRequest, ctx: FlowContext):
            await ctx.enqueue({"topic": "pipeline.analyze", "data": {"text": req.body["text"]}})
            return ApiResponse(statusCode=200, body=ctx.stream.subscription())

    Example — queue step that publishes progress::

        async def handler(data: dict, ctx: FlowContext):
            await ctx.stream.set("step-1", {"step": 1, "total": 4, "label": "Tokenizing"})
            await ctx.stream.set("result", {"done": True, **stats})

    Multi-trigger step::

        async def handler(input, ctx: FlowContext):
            return await ctx.match({
                "http":  lambda req: ApiResponse(statusCode=200, body={"ok": True}),
                "queue": lambda data: process(data),
                "cron":  lambda: run_sweep(),
            })
    """
    logger: ILogger
    state: IState
    stream: IStream
    trigger_type: str

    @property
    def stream_name(self) -> str:
        """The stream name used by implicit ``ctx.stream.set()`` / ``ctx.stream.send()``."""
        ...

    async def enqueue(self, payload: dict) -> None:
        """Emit a message to a topic.

        Example::

            await ctx.enqueue({"topic": "order.created", "data": {"id": "x"}})
        """
        ...

    async def enqueue_named(self, payload: dict) -> dict:
        """Dispatch directly to a function via a named queue.

        Unlike ``enqueue()``, this targets a specific function and routes it
        through a named queue for FIFO ordering, concurrency control, or
        custom retry behaviour. Requires the queue to be declared in
        nvent's ``queue_configs``.

        Returns ``{"messageReceiptId": "..."}`` immediately.

        Example::

            result = await ctx.enqueue_named({
                "queue": "orders",
                "function_id": "orders::process",
                "data": {"orderId": "123"},
            })
        """
        ...

    async def match(self, handlers: dict[str, Any]) -> Any:
        """Route to a sub-handler based on the trigger type.

        Example::

            return await ctx.match({
                "http":  lambda req: ApiResponse(statusCode=200, body={"ok": True}),
                "queue": lambda data: process(data),
                "cron":  lambda: run_sweep(),
            })
        """
        ...


# ── define_function ────────────────────────────────────────────────────────

_NVENT_FN_MARKER = "__nvent_fn__"


def define_function(
    *,
    description: str = "",
    triggers: list[dict] = None,
    handler: NventHandler,
) -> dict:
    """Declare a nvent function without a ``config`` dict.

    The function ID is derived from the file path at registration time.
    The handler signature depends on the trigger type:

    - ``http``:   ``async def handler(req: ApiRequest) -> ApiResponse``
    - ``queue``:  ``async def handler(data: dict, ctx: FlowContext) -> None``
    - ``cron``:   ``async def handler(ctx: FlowContext) -> None``

    Example::

        from nvent import define_function, http, ApiRequest, ApiResponse, Logger

        logger = Logger("greet")

        async def handler(req: ApiRequest) -> ApiResponse:
            logger.info("called")
            return ApiResponse(statusCode=200, body={"hello": "world"})

        define_function(
            description="Greet endpoint",
            triggers=[http("GET", "/greet")],
            handler=handler,
        )
    """
    return {
        _NVENT_FN_MARKER: True,
        "description": description,
        "triggers": list(triggers or []),
        "handler": handler,
    }


# ── Runtime override (worker process only) ─────────────────────────────────
# Inside a worker, _runtime is on sys.path and provides real implementations.
# These imports overwrite the stubs above at runtime without affecting
# static analysis (Pylance sees the unconditional definitions above).

try:
    from _runtime import (  # type: ignore[no-redef]  # noqa: F401, E402
        http,
        queue,
        cron,
        define_function,
        FlowContext,
    )
    from iii import ApiRequest, ApiResponse, Logger  # type: ignore[no-redef]  # noqa: F401, E402
except ImportError:
    pass


__all__ = [
    "http",
    "queue",
    "cron",
    "define_function",
    "Logger",
    "FlowContext",
    "ApiRequest",
    "ApiResponse",
    "NventHandler",
    "IStream",
    "ILogger",
    "IState",
]
