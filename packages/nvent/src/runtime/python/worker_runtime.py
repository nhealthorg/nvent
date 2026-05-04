# nvent Python worker runtime
#
# This file is copied to .nuxt/iii-workers/_runtime.py at dev startup.
# Generated worker entry scripts (e.g. __shared__.py, <fn-id>.py) import from it
# so all shared logic lives here as real, editable Python — not embedded strings.
#
# Use in your step files:
#   from nvent import http, queue, cron, FlowContext, ApiRequest, ApiResponse
#
# Responsibilities:
#   http/queue/cron    — trigger config helpers (same API as motia)
#   FlowContext        — ctx object passed to handlers (ctx.logger, ctx.state, ctx.enqueue, ctx.match)
#   _load(path, name)  — load a .py module from an absolute path
#   _register(client, mod, default_id)  — register a module's handler + triggers
#   _iii_sdk           — the iii Python SDK (re-exported for entry scripts)

import sys
import re
import inspect
import importlib.util
import logging as _logging

try:
    import iii as _iii_sdk
except ImportError:
    print("[nvent] iii package not found — install it: pip install iii-sdk[otel]", flush=True)
    sys.exit(1)

# Direct Python logging to stdout so nvent captures it alongside other output.
# DEBUG and above are collected; the JS side filters by logLevel.
_logging.basicConfig(
    level=_logging.DEBUG,
    stream=sys.stdout,
    format="[%(levelname)s] %(name)s: %(message)s",
    force=True,
)

# ---------------------------------------------------------------------------
# OpenTelemetry tracing helpers — gracefully disabled when otel is not available
# ---------------------------------------------------------------------------

try:
    from opentelemetry import trace as _otel_trace
    from opentelemetry.trace import SpanKind as _SpanKind, StatusCode as _StatusCode
    _HAS_OTEL = True
except ImportError:
    _HAS_OTEL = False

import contextlib


def _get_tracer():
    """Return the nvent OTel tracer, or None when OTel is not available."""
    if not _HAS_OTEL:
        return None
    return _otel_trace.get_tracer("nvent")


@contextlib.contextmanager
def operation_span(operation: str, **attributes):
    """Context manager that creates an OTel child span for an operation.

    When OTel is not installed (``opentelemetry-api`` not on sys.path),
    this is a no-op — ``span`` is ``None`` inside the block.

    Usage::

        with operation_span("state::get", **{"nvent.state.scope": scope, "nvent.state.key": key}) as span:
            try:
                result = await client.trigger_async(...)
                set_span_ok(span)
                return result
            except Exception as exc:
                record_exception(span, exc)
                raise
    """
    tracer = _get_tracer()
    if not tracer:
        yield None
        return
    with tracer.start_as_current_span(
        operation,
        kind=_SpanKind.CLIENT,
        attributes={k: v for k, v in attributes.items() if v is not None},
    ) as span:
        yield span


def record_exception(span, exc: Exception) -> None:
    """Record an exception on a span and mark it as errored."""
    if _HAS_OTEL and span is not None:
        span.set_status(_StatusCode.ERROR, str(exc))
        span.record_exception(exc)


def set_span_ok(span) -> None:
    """Mark a span as successfully completed."""
    if _HAS_OTEL and span is not None:
        span.set_status(_StatusCode.OK)


# Internal key used to propagate the stream channel through queue messages.
_NVENT_STREAM_KEY = '__nventStream'


# ---------------------------------------------------------------------------
# Trigger config helpers — use these in config["triggers"]
# ---------------------------------------------------------------------------

def http(method: str, path: str) -> dict:
    """HTTP trigger: http("POST", "/my-endpoint")"""
    return {"type": "http", "method": method.upper(), "path": path}


def queue(topic: str) -> dict:
    """Queue (durable:subscriber) trigger: queue("order.created")"""
    return {"type": "durable:subscriber", "topic": topic}


def cron(expression: str) -> dict:
    """Cron trigger: cron("0 0 * * * * *")  (7-field: sec min hour dom month dow year)"""
    return {"type": "cron", "expression": expression}


_NVENT_FN_MARKER = "__nvent_fn__"


def define_function(*, description: str = "", triggers: list = None, handler) -> dict:
    """Thin wrapper: declares a nvent function without a config dict.

    The function ID is derived from the file path at registration time.
    The handler receives **raw input only** — no ctx argument.

    Usage::

        from nvent import define_function, http, Logger

        logger = Logger()

        async def handler(req):
            logger.info("called", {"name": req.query_params.get("name")})
            return {"statusCode": 200, "body": {"hello": "world"}}

        define_function(
            description="Greet endpoint",
            triggers=[http("GET", "/greet")],
            handler=handler,
        )
    """
    result = {
        _NVENT_FN_MARKER: True,
        "description": description,
        "triggers": list(triggers or []),
        "handler": handler,
    }
    # Auto-register into the calling module's namespace so _register() can
    # find it even when the caller does not assign the return value to a variable.
    # Uses CPython frame introspection — safe for all CPython 3.x deployments.
    import sys as _sys
    _caller = _sys._getframe(1)
    _fns = _caller.f_globals.setdefault('__nvent_fns__', [])
    _fns.append(result)
    return result


class _Stream:
    """Access to the iii Stream module.

    **Implicit API** (recommended): ``set(item_id, data)`` automatically uses
    the function's flow/stream name and the current OTel trace ID as the group
    ID.  All steps that run in the same request share the same trace → same
    group, so they write to a consistent WebSocket channel without manual
    coordination.

    **Explicit API**: ``set_in(name, group, item_id, data)`` targets any
    specific stream and group.

    Available as ``ctx.stream``.
    """

    def __init__(self, client, stream_name: str, get_group_id):
        self._client = client
        self._stream_name = stream_name
        self._get_group_id = get_group_id

    # ------------------------------------------------------------------
    # Implicit helpers — use flow stream + trace ID automatically
    # ------------------------------------------------------------------

    async def set(self, item_id: str, data: dict) -> None:
        """Set (create/update) an item in the implicit stream channel."""
        group = self._get_group_id()
        with operation_span("stream::set", **{
            "nvent.stream.name": self._stream_name,
            "nvent.stream.group_id": group,
            "nvent.stream.item_id": item_id,
        }) as span:
            try:
                await self._client.trigger_async({"function_id": "stream::set", "payload": {
                    "stream_name": self._stream_name,
                    "group_id": group,
                    "item_id": item_id,
                    "data": data,
                }})
                set_span_ok(span)
            except Exception as exc:
                record_exception(span, exc)
                raise

    async def send(self, data: dict) -> None:
        """Send a custom event to all subscribers of the implicit stream channel."""
        group = self._get_group_id()
        with operation_span("stream::send", **{
            "nvent.stream.name": self._stream_name,
            "nvent.stream.group_id": group,
        }) as span:
            try:
                await self._client.trigger_async({"function_id": "stream::send", "payload": {
                    "stream_name": self._stream_name,
                    "group_id": group,
                    "data": data,
                }})
                set_span_ok(span)
            except Exception as exc:
                record_exception(span, exc)
                raise

    def subscription(self) -> dict:
        """Return ``{"streamName": ..., "groupId": ...}`` for the implicit channel.

        Return this dict from an HTTP handler so the client knows where to subscribe::

            return ApiResponse(statusCode=200, body=ctx.stream.subscription())
        """
        return {"streamName": self._stream_name, "groupId": self._get_group_id()}

    # ------------------------------------------------------------------
    # Explicit helpers — target any stream + group
    # ------------------------------------------------------------------

    async def set_in(self, name: str, group: str, item_id: str, data: dict) -> None:
        """Set (create/update) an item in an explicit stream group."""
        with operation_span("stream::set", **{
            "nvent.stream.name": name,
            "nvent.stream.group_id": group,
            "nvent.stream.item_id": item_id,
        }) as span:
            try:
                await self._client.trigger_async({"function_id": "stream::set", "payload": {
                    "stream_name": name, "group_id": group, "item_id": item_id, "data": data,
                }})
                set_span_ok(span)
            except Exception as exc:
                record_exception(span, exc)
                raise

    async def get_item(self, name: str, group: str, item_id: str) -> dict:
        """Get a single item from a stream group."""
        with operation_span("stream::get", **{
            "nvent.stream.name": name,
            "nvent.stream.group_id": group,
            "nvent.stream.item_id": item_id,
        }) as span:
            try:
                result = await self._client.trigger_async({"function_id": "stream::get", "payload": {
                    "stream_name": name, "group_id": group, "item_id": item_id,
                }})
                set_span_ok(span)
                return result
            except Exception as exc:
                record_exception(span, exc)
                raise

    async def delete_item(self, name: str, group: str, item_id: str) -> None:
        """Delete an item from a stream group."""
        with operation_span("stream::delete", **{
            "nvent.stream.name": name,
            "nvent.stream.group_id": group,
            "nvent.stream.item_id": item_id,
        }) as span:
            try:
                await self._client.trigger_async({"function_id": "stream::delete", "payload": {
                    "stream_name": name, "group_id": group, "item_id": item_id,
                }})
                set_span_ok(span)
            except Exception as exc:
                record_exception(span, exc)
                raise

    async def list_items(self, name: str, group: str) -> list:
        """List all items in a stream group."""
        with operation_span("stream::list", **{
            "nvent.stream.name": name,
            "nvent.stream.group_id": group,
        }) as span:
            try:
                result = await self._client.trigger_async({"function_id": "stream::list", "payload": {"stream_name": name, "group_id": group}})
                set_span_ok(span)
                return result
            except Exception as exc:
                record_exception(span, exc)
                raise

    async def send_to(self, name: str, group: str, data: dict) -> None:
        """Send a custom event to all subscribers of an explicit stream group."""
        with operation_span("stream::send", **{
            "nvent.stream.name": name,
            "nvent.stream.group_id": group,
        }) as span:
            try:
                await self._client.trigger_async({"function_id": "stream::send", "payload": {
                    "stream_name": name, "group_id": group, "data": data,
                }})
                set_span_ok(span)
            except Exception as exc:
                record_exception(span, exc)
                raise


# ---------------------------------------------------------------------------
# State manager sub-object — accessible as ctx.state
# ---------------------------------------------------------------------------

class _State:
    """Provides ctx.state.get/set/delete/list — scope is auto-bound to the function ID."""

    def __init__(self, client, fn_id: str):
        self._client = client
        self._fn_id = fn_id

    async def get(self, key: str):
        with operation_span("state::get", **{"nvent.state.scope": self._fn_id, "nvent.state.key": key}) as span:
            try:
                result = await self._client.trigger_async({"function_id": "state::get", "payload": {"scope": self._fn_id, "key": key}})
                set_span_ok(span)
                return result
            except Exception as exc:
                record_exception(span, exc)
                raise

    async def set(self, key: str, value) -> None:
        with operation_span("state::set", **{"nvent.state.scope": self._fn_id, "nvent.state.key": key}) as span:
            try:
                result = await self._client.trigger_async({"function_id": "state::set", "payload": {"scope": self._fn_id, "key": key, "value": value}})
                set_span_ok(span)
                return result
            except Exception as exc:
                record_exception(span, exc)
                raise

    async def delete(self, key: str) -> None:
        with operation_span("state::delete", **{"nvent.state.scope": self._fn_id, "nvent.state.key": key}) as span:
            try:
                await self._client.trigger_async({"function_id": "state::delete", "payload": {"scope": self._fn_id, "key": key}})
                set_span_ok(span)
            except Exception as exc:
                record_exception(span, exc)
                raise

    async def list(self):
        with operation_span("state::list", **{"nvent.state.scope": self._fn_id}) as span:
            try:
                result = await self._client.trigger_async({"function_id": "state::list", "payload": {"scope": self._fn_id}})
                set_span_ok(span)
                return result
            except Exception as exc:
                record_exception(span, exc)
                raise


# ---------------------------------------------------------------------------
# FlowContext — execution context passed to handler(input, ctx)
# ---------------------------------------------------------------------------

class FlowContext:
    """Execution context passed as the second argument to Python step handlers.

      ctx.logger           — structured logger (OTel-backed when available, else stdout)
      ctx.state            — key-value store (ctx.state.get / .set / .delete / .list)
      ctx.stream           — stream channel (ctx.stream.set / .send / .subscription)
      ctx.trace_id         — current OTel trace ID (shared across all steps in the same request)
      ctx.stream_name      — stream name used by implicit ctx.stream ops
      ctx.enqueue()        — emit a message to a topic
      ctx.match()          — route to a trigger-type-specific sub-handler

    Implicit stream usage (recommended)::

        # All steps in the same trace write to the same channel automatically:
        await ctx.stream.set("step-1", {"label": "Tokenizing", "step": 1})

        # HTTP handler: return subscription info for the client
        return ApiResponse(statusCode=200, body=ctx.stream.subscription())

    Explicit stream (cross-flow or specific group)::

        await ctx.stream.set_in("other-flow", "group-123", "item", data)
    """

    def __init__(self, client, fn_id: str, trigger_type: str, input_data, stream_name: str = "", inherited_group_id: str = None):
        self._client = client
        self._fn_id = fn_id
        self._trigger_type = trigger_type
        self._input = input_data
        self._stream_name = stream_name or fn_id.split("::")[0]
        self._stream_group_id = inherited_group_id
        self.logger = _iii_sdk.Logger(fn_id)
        self.state = _State(client, fn_id)
        self.stream = _Stream(client, self._stream_name, self._get_or_create_group_id)

    def _get_or_create_group_id(self) -> str:
        """Return stable group ID for this invocation, generating one lazily if needed."""
        if not self._stream_group_id:
            import uuid
            self._stream_group_id = str(uuid.uuid4())
        return self._stream_group_id

    @property
    def stream_name(self) -> str:
        """The stream name used by implicit ``ctx.stream.set()`` / ``ctx.stream.send()``."""
        return self._stream_name

    async def enqueue(self, payload: dict) -> None:
        """Emit a message to a queue topic.
        Include ``streamName`` and ``groupId`` in ``data`` if you need the
        next step to write to the same stream group.
        Usage: await ctx.enqueue({"topic": "order.created", "data": {"id": "x", "streamName": ..., "groupId": ...}})
        """
        topic = payload.get("topic")
        data = dict(payload.get("data") or {})
        await self._client.trigger_async({
            "function_id": "iii::durable::publish",
            "payload": {"topic": topic, "data": data},
        })

    async def enqueue_named(self, payload: dict) -> dict:
        """Dispatch directly to a function via a named queue.

        Unlike ``enqueue()``, which publishes to a topic, this targets a
        specific function and routes the call through the named queue for
        FIFO ordering, concurrency control, or custom retry behaviour.
        Requires the queue to be declared in nvent's ``queue_configs``.

        Returns ``{"messageReceiptId": "..."}`` immediately — the function
        runs asynchronously.

        Usage::

            result = await ctx.enqueue_named({
                "queue": "orders",
                "function_id": "orders::process",
                "data": {"orderId": "123"},
            })
        """
        queue = payload["queue"]
        function_id = payload["function_id"]
        data = payload.get("data")
        return await self._client.trigger_async({
            "function_id": function_id,
            "payload": data,
            "action": {"type": "enqueue", "queue": queue},
        })

    async def match(self, handlers: dict):
        """Route to a sub-handler based on the trigger type that activated this step.

        Each value in the dict is an async callable:
          "http"  → receives ApiRequest
          "queue" → receives the queue data dict
          "cron"  → receives no arguments
          "default" → fallback for unmatched trigger types
        """
        handler = handlers.get(self._trigger_type) or handlers.get("default")
        if handler is None:
            raise ValueError(
                f"[nvent] ctx.match(): no handler for trigger type '{self._trigger_type}'. "
                f"Available: {list(handlers)}"
            )
        sig = inspect.signature(handler)
        # Count required positional params (ignores *args, **kwargs, params with defaults)
        required = sum(
            1 for p in sig.parameters.values()
            if p.default is inspect.Parameter.empty
            and p.kind not in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)
        )
        if required == 0:
            return await handler()
        return await handler(self._input)


# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

def _load(path: str, name: str):
    """Load a Python module from an absolute file path."""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# Registration — reads config dict (motia-style) or meta+triggers (legacy)
# ---------------------------------------------------------------------------

def _normalize_trigger_meta(t: dict) -> dict:
    """Return a flat {type, path/topic/expression} dict for console metadata."""
    t_type = t.get("type", "")
    if t_type == "http":
        path = t.get("path") or (t.get("config") or {}).get("api_path")
        method = t.get("method") or (t.get("config") or {}).get("http_method")
        return {"type": "http", "path": path, "method": method}
    if t_type == "queue":
        topic = t.get("topic") or (t.get("config") or {}).get("topic")
        return {"type": "queue", "topic": topic}
    if t_type == "cron":
        expr = t.get("expression") or (t.get("config") or {}).get("expression")
        return {"type": "cron", "expression": expr}
    cfg = dict(t.get("config") or {})
    return {"type": t_type, **cfg}


def _trigger_to_iii_cfg(t: dict) -> dict:
    """Convert a trigger dict to the engine-facing config (api_path/http_method for HTTP)."""
    t_type = t.get("type", "")
    if t_type == "http":
        path = t.get("path") or (t.get("config") or {}).get("api_path") or ""
        method = t.get("method") or (t.get("config") or {}).get("http_method") or "GET"
        return {"api_path": path, "http_method": method}
    if t_type == "queue":
        topic = t.get("topic") or (t.get("config") or {}).get("topic") or ""
        return {"topic": topic}
    if t_type == "cron":
        expr = t.get("expression") or (t.get("config") or {}).get("expression") or ""
        return {"expression": expr}
    return dict(t.get("config") or {k: v for k, v in t.items() if k != "type"})


def _trigger_suffix(trigger: dict) -> str:
    """Build a descriptive trigger suffix (no whitespace for valid function_id)."""
    t_type = trigger.get("type", "")
    if t_type == "http":
        method = trigger.get("method") or (trigger.get("config") or {}).get("http_method", "GET")
        path = trigger.get("path") or (trigger.get("config") or {}).get("api_path", "/")
        return f"http({method}_{path})"
    if t_type == "queue":
        topic = trigger.get("topic") or (trigger.get("config") or {}).get("topic", "")
        return f"queue({topic})"
    if t_type == "cron":
        expr = trigger.get("expression") or (trigger.get("config") or {}).get("expression", "")
        return f"cron({expr})"
    return t_type


def _register(client, mod, default_id: str) -> None:
    """Register a loaded module's handler and triggers with the iii client.

    Supports three step file formats (in priority order):

    **1. define_function() style** (preferred — matches new TS thin API):
        ``define_function(description=..., triggers=[...], handler=handler)``
        Called as a bare statement (result need not be assigned to a variable).
        Handler takes ``(input,)`` only.

    **2. config dict format** (still supported):
        ``config = {"name": "my-step", "triggers": [...], ...}``
        ``async def handler(input, ctx: FlowContext): ...``

    **3. Legacy meta/triggers format**:
        ``meta = {"id": "my-step", ...}``
        ``triggers = [{"type": "http", "config": {...}}]``
        ``async def handler(input, ctx): ...``
    """
    # ── 1. define_function() style ───────────────────────────────────────────
    # Primary: __nvent_fns__ list populated by define_function()'s frame magic
    # (works even when the caller does not assign the return value).
    # Fallback: scan module vars for a dict marked with _NVENT_FN_MARKER
    # (supports the `fn = define_function(...)` assignment style).
    fn_defs_list = getattr(mod, '__nvent_fns__', None)
    if not fn_defs_list:
        fn_defs_list = [
            v for v in vars(mod).values()
            if isinstance(v, dict) and v.get(_NVENT_FN_MARKER)
        ]

    if fn_defs_list:
        for fn_def in fn_defs_list:
            _register_one(client, mod, default_id, fn_def)
        return

    # ── 2. config dict / 3. legacy meta+triggers ─────────────────────────────
    _register_legacy(client, mod, default_id)


def _register_one(client, mod, default_id: str, fn_def: dict) -> None:
    """Register a single define_function() entry."""
    fn_id = default_id
    description = fn_def.get("description", "")
    triggers = list(fn_def.get("triggers") or [])
    handler_fn = fn_def.get("handler")
    if not handler_fn:
        print(f"[nvent] define_function() in {getattr(mod, '__file__', '?')} has no handler — skipping", flush=True)
        return
    file_path = getattr(mod, "__file__", None)
    metadata = {
        "name": fn_id,
        "description": description,
        "filePath": file_path,
        "triggers": [_normalize_trigger_meta(t) for t in triggers],
    }
    seen_suffixes: set = set()
    for i, trigger in enumerate(triggers):
        t_type = trigger.get("type", "")
        suffix = _trigger_suffix(trigger)
        if suffix in seen_suffixes:
            suffix = f"{suffix}::{i}"
        seen_suffixes.add(suffix)
        function_id = f"steps::{fn_id}::trigger::{suffix}"
        iii_cfg = _trigger_to_iii_cfg(trigger)
        is_http = t_type == "http"

        def _make_wrapper_thin(_h, _is_http):
            async def _wrapped(data):
                input_data = _iii_sdk.ApiRequest(**data) if (_is_http and isinstance(data, dict)) else data
                return await _h(input_data)
            return _wrapped

        wrapped = _make_wrapper_thin(handler_fn, is_http)
        iii_trigger_type = "durable:subscriber" if t_type == "queue" else t_type
        client.register_function(function_id, wrapped, metadata=metadata)
        client.register_trigger({"type": iii_trigger_type, "function_id": function_id, "config": iii_cfg})
    print(f"[nvent] registered {fn_id!r} ({len(triggers)} trigger(s))", flush=True)


def _register_legacy(client, mod, default_id: str) -> None:
    """Register using config dict (format 2) or meta+triggers (format 3)."""
    config_dict = getattr(mod, "config", None)

    if config_dict is not None:
        fn_id = config_dict.get("name") or default_id
        if not config_dict.get("name"):
            print(f"[nvent] WARNING: Python step at {getattr(mod, '__file__', '?')} has no 'name' in config — "
                  f"falling back to file-path-derived name {fn_id!r}. "
                  "Add `config['name'] = '<your-step-name>'` to fix this.", flush=True)
        description = config_dict.get("description")
        triggers = list(config_dict.get("triggers") or [])
        flows = list(config_dict.get("flows") or [])
        enqueues = list(config_dict.get("enqueues") or [])
        stream_name = config_dict.get("stream") or (flows[0] if flows else fn_id.split("::")[0])
    else:
        meta = dict(getattr(mod, "meta", {}) or {})
        fn_id = meta.get("name") or default_id
        if not meta.get("name"):
            print(f"[nvent] WARNING: Python step at {getattr(mod, '__file__', '?')} has no 'name' in meta — "
                  f"falling back to file-path-derived name {fn_id!r}. "
                  "Add `meta['name'] = '<your-step-name>'` to fix this.", flush=True)
        description = meta.get("description")
        triggers = list(getattr(mod, "triggers", []) or [])
        flows = list(meta.get("flows") or [])
        enqueues = list(meta.get("enqueues") or [])
        stream_name = meta.get("stream") or (flows[0] if flows else fn_id.split("::")[0])

    handler_fn = getattr(mod, "handler", None)
    file_path = getattr(mod, "__file__", None)

    if not handler_fn:
        print(f"[nvent] Python function {fn_id!r} has no handler — skipping", flush=True)
        return

    sig = inspect.signature(handler_fn)
    has_ctx = len(list(sig.parameters)) >= 2

    metadata = {
        "name": fn_id,
        "description": description,
        "filePath": file_path,
        "triggers": [_normalize_trigger_meta(t) for t in triggers],
        "flows": flows,
        "enqueues": enqueues,
    }

    seen_suffixes: set = set()
    for i, trigger in enumerate(triggers):
        t_type = trigger.get("type", "")
        suffix = _trigger_suffix(trigger)
        if suffix in seen_suffixes:
            suffix = f"{suffix}::{i}"
        seen_suffixes.add(suffix)

        function_id = f"steps::{fn_id}::trigger::{suffix}"
        iii_cfg = _trigger_to_iii_cfg(trigger)
        is_http = t_type == "http"

        def _make_wrapper(_h, _is_http, _t_type, _fn_id, _hc, _stream_name):
            async def _wrapped(data):
                inherited_group = None
                effective_stream = _stream_name
                clean_data = data
                if isinstance(data, dict) and _NVENT_STREAM_KEY in data:
                    nvent_stream = data[_NVENT_STREAM_KEY]
                    if isinstance(nvent_stream, dict):
                        inherited_group = nvent_stream.get('groupId')
                        effective_stream = nvent_stream.get('name') or _stream_name
                    clean_data = {k: v for k, v in data.items() if k != _NVENT_STREAM_KEY}
                input_data = _iii_sdk.ApiRequest(**clean_data) if (_is_http and isinstance(clean_data, dict)) else clean_data
                if not _hc:
                    return await _h(input_data)
                ctx = FlowContext(client, _fn_id, _t_type, input_data, effective_stream, inherited_group)
                return await _h(input_data, ctx)
            return _wrapped

        wrapped = _make_wrapper(handler_fn, is_http, t_type, fn_id, has_ctx, stream_name)
        iii_trigger_type = "durable:subscriber" if t_type == "queue" else t_type
        client.register_function(
            function_id,
            wrapped,
            metadata=metadata,
        )
        client.register_trigger({
            "type": iii_trigger_type,
            "function_id": function_id,
            "config": iii_cfg,
        })

    print(f"[nvent] registered {fn_id!r} ({len(triggers)} trigger(s))", flush=True)


# ---------------------------------------------------------------------------
# CLI entry point — invoked by the TypeScript worker manager:
#   python3 _runtime.py <ws_url> <worker_name> <path1> <id1> [<path2> <id2> ...]
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 4 or (len(sys.argv) - 3) % 2 != 0:
        print(
            "Usage: _runtime.py <ws_url> <worker_name> <path1> <id1> [<path2> <id2> ...]",
            file=sys.stderr,
        )
        sys.exit(1)

    _ws_url = sys.argv[1]
    _worker_name = sys.argv[2]
    _fn_pairs = [(sys.argv[i], sys.argv[i + 1]) for i in range(3, len(sys.argv), 2)]

    options = _iii_sdk.InitOptions(
        worker_name=_worker_name,
        otel={"enabled": True, "service_name": "nvent", "metrics_enabled": False},
        telemetry=_iii_sdk.TelemetryOptions(framework="nvent", project_name=_worker_name),
    )
    client = _iii_sdk.register_worker(_ws_url, options)
    for _path, _fn_id in _fn_pairs:
        _mod = _load(_path, _fn_id)
        _register(client, _mod, _fn_id)
    # Keep process alive — the SDK's background thread is daemon=True so we must
    # block the main thread until the process is externally killed.
    client._thread.join()
