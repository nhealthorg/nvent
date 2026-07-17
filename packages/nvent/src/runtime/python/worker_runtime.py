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
import asyncio
import time
import uuid
from typing import Any

try:
    import iii as _iii_sdk
    from iii_helpers.http import HttpRequest as _HttpRequest, HttpResponse as _HttpResponse
    from iii_helpers.observability import Logger
except ImportError:
    print("[nvent] iii package not found — install it: pip install iii-sdk[otel] iii-helpers", flush=True)
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


def _current_trace_id_hex() -> str | None:
    if not _HAS_OTEL:
        return None
    span = _otel_trace.get_current_span()
    if span is None:
        return None
    ctx = span.get_span_context()
    if not ctx or not ctx.is_valid:
        return None
    return f"{ctx.trace_id:032x}"


def _current_span_id_hex() -> str | None:
    if not _HAS_OTEL:
        return None
    span = _otel_trace.get_current_span()
    if span is None:
        return None
    ctx = span.get_span_context()
    if not ctx or not ctx.is_valid:
        return None
    return f"{ctx.span_id:016x}"


def _record_workflow_span_event(name: str, **attributes) -> None:
    if not _HAS_OTEL:
        return
    span = _otel_trace.get_current_span()
    if span is None:
        return
    span.add_event(name, {k: v for k, v in attributes.items() if v is not None})


async def _emit_workflow_trace_event(client, fn_id: str, wf: dict, event_name: str, extra_attrs: dict | None = None) -> None:
    attrs = {
        "iii.function.id": fn_id,
        "workflow.node_uid": wf.get('node_uid'),
        "workflow.run_id": wf.get('run_id'),
        "workflow.runtime": "python",
    }
    if extra_attrs:
        attrs.update(extra_attrs)

    _record_workflow_span_event(event_name, **attrs)

    payload = {
        'run_id': wf['run_id'],
        'id': f"trace-{int(time.time() * 1000)}-{uuid.uuid4().hex[:10]}",
        'node_uid': wf.get('node_uid'),
        'function_id': fn_id,
        'runtime': 'python',
        'event_name': event_name,
        'ts_unix_ms': int(time.time() * 1000),
        'attributes': attrs,
    }
    trace_id = wf.get('trace_id') or _current_trace_id_hex()
    span_id = _current_span_id_hex()
    if trace_id:
        payload['trace_id'] = trace_id
    if span_id:
        payload['span_id'] = span_id

    try:
        await client.trigger_async({
            'function_id': 'workflow::trace-write',
            'payload': payload,
        })
    except Exception as exc:
        print(f"[nvent/workflow] failed to write trace event {event_name} for {fn_id}: {exc}", flush=True)


class _ContextLogger:
    def __init__(self, client, fn_id: str, *, run_id: str | None = None, node_uid: str | None = None, trace_id: str | None = None):
        self._client = client
        self._fn_id = fn_id
        self._run_id = run_id
        self._node_uid = node_uid
        self._trace_id = trace_id
        self._pending: set[asyncio.Task] = set()

    def _emit(self, level: str, message: str, data: Any = None) -> None:
        ts_unix_ms = int(time.time() * 1000)

        trace_id = self._trace_id or _current_trace_id_hex()
        span_id = _current_span_id_hex()

        structured = {
            **(data if isinstance(data, dict) else ({'value': data} if data is not None else {})),
            'level': level,
            'iii.function.id': self._fn_id,
        }
        if self._run_id:
            structured['workflow.run_id'] = self._run_id
        if self._node_uid:
            structured['workflow.node_uid'] = self._node_uid
        if trace_id:
            structured['trace_id'] = trace_id
        if span_id:
            structured['span_id'] = span_id

        if self._run_id:
            log_payload = {
                'run_id': self._run_id,
                'id': f"log-{ts_unix_ms}-{uuid.uuid4().hex[:10]}",
                'node_uid': self._node_uid,
                'function_id': self._fn_id,
                'runtime': 'python',
                'level': level,
                'message': message,
                'ts_unix_ms': ts_unix_ms,
                'data': structured,
            }
            task = asyncio.create_task(self._client.trigger_async({
                'function_id': 'workflow::log-write',
                'payload': log_payload,
            }))
        else:
            engine_level = 'info' if level == 'debug' else level
            payload = {
                'message': message,
                'service_name': 'nvent',
                'data': structured,
            }
            if trace_id:
                payload['trace_id'] = trace_id
            if span_id:
                payload['span_id'] = span_id
            task = asyncio.create_task(self._client.trigger_async({
                'function_id': f'engine::log::{engine_level}',
                'payload': payload,
            }))

        self._pending.add(task)

        def _cleanup(done_task):
            self._pending.discard(done_task)
            try:
                done_task.result()
            except Exception as exc:
                print(f"[nvent/logger] failed to emit {level} log for {self._fn_id}: {exc}", flush=True)

        task.add_done_callback(_cleanup)

    def debug(self, message: str, data: Any = None) -> None:
        self._emit('debug', message, data)

    def info(self, message: str, data: Any = None) -> None:
        self._emit('info', message, data)

    def warn(self, message: str, data: Any = None) -> None:
        self._emit('warn', message, data)

    def error(self, message: str, data: Any = None) -> None:
        self._emit('error', message, data)

    async def flush(self) -> None:
        if not self._pending:
            return
        await asyncio.gather(*list(self._pending), return_exceptions=True)


# Internal key used to propagate the stream channel through queue messages.
_NVENT_STREAM_KEY = '__nventStream'


# ---------------------------------------------------------------------------
# HTTP Request/Response wrappers — convenience aliases for iii_helpers.http
# ---------------------------------------------------------------------------

# Expose iii_helpers.http types as ApiRequest/ApiResponse for backward compatibility
ApiRequest = _HttpRequest
ApiResponse = _HttpResponse


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


def define_function(
    *,
    description: str = "",
    triggers: list = None,
    workflow = None,
    request_format = None,
    response_format = None,
    handler,
    **extra,
) -> dict:
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
            workflow={"queue": "default"},
            request_format={"type": "object"},
            response_format={"type": "object"},
            handler=handler,
        )
    """
    result = {
        _NVENT_FN_MARKER: True,
        "description": description,
        "triggers": list(triggers or []),
        "workflow": workflow,
        "request_format": request_format,
        "response_format": response_format,
        "handler": handler,
    }
    # Preserve unknown keyword arguments for forward compatibility with TS defineFunction.
    result.update(extra)
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

    def __init__(self, client, fn_id: str, trigger_type: str, input_data, stream_name: str = "", inherited_group_id: str = None, workflow_meta: dict = None):
        self._client = client
        self._fn_id = fn_id
        self._trigger_type = trigger_type
        self._input = input_data
        self._stream_name = stream_name or fn_id.split("::")[0]
        self._stream_group_id = inherited_group_id
        self.logger = _ContextLogger(
            client,
            fn_id,
            run_id=(workflow_meta or {}).get("run_id"),
            node_uid=(workflow_meta or {}).get("node_uid"),
            trace_id=(workflow_meta or {}).get("trace_id"),
        )
        if workflow_meta:
            self.run_id = workflow_meta.get("run_id")
            self.node_uid = workflow_meta.get("node_uid")
            self.trace_id = workflow_meta.get("trace_id")
        else:
            self.run_id = None
            self.node_uid = None
            self.trace_id = _current_trace_id_hex()
            
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


def _workflow_queue_from_config(workflow_cfg) -> str | None:
    if workflow_cfg is True:
        return "default"
    if isinstance(workflow_cfg, dict):
        unsupported = [k for k in workflow_cfg.keys() if k not in {"queue", "engine_retry"}]
        if unsupported:
            print(
                f"[nvent/workflow] ignoring unsupported workflow options: {', '.join(sorted(unsupported))}. "
                "Configure retries/concurrency/fifo in nvent iii queueConfigs.",
                flush=True,
            )
        queue = workflow_cfg.get("queue")
        if isinstance(queue, str) and queue.strip():
            return queue.strip()
        return "default"
    return None


def _register_workflow_subscriber(client, fn_id: str, workflow_cfg) -> bool:
    queue = _workflow_queue_from_config(workflow_cfg)
    if not queue:
        return False

    print(f"[nvent/workflow] subscribing workflow-enabled function {fn_id!r} to queue {queue!r}", flush=True)
    client.register_trigger({
        "type": "durable:subscriber",
        "function_id": fn_id,
        "config": {"queue": queue},
    })
    return True


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
    workflow_cfg = fn_def.get("workflow")
    request_format = fn_def.get("request_format")
    response_format = fn_def.get("response_format")
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
        "workflow": workflow_cfg,
        "request_format": request_format,
        "response_format": response_format,
    }

    # If no triggers, register the function directly so it can be called by workflows
    if len(triggers) == 0:
        def _make_wrapper_no_trigger(_h, _client, _fn_id):
            async def _wrapped(data):
                # Detect workflow orchestration metadata and unwrap input
                is_workflow = isinstance(data, dict) and '_workflow' in data
                wf = data.get('_workflow') if is_workflow else None
                has_workflow_meta = isinstance(wf, dict) and 'run_id' in wf and 'node_uid' in wf
                
                if has_workflow_meta:
                    print(f"[nvent/workflow] executing node {wf['node_uid']} in run {wf['run_id']} via {_fn_id}", flush=True)
                
                # Extract actual input (unwrap from workflow envelope)
                actual_input = data.get('input') if has_workflow_meta else data
                
                if has_workflow_meta and _HAS_OTEL:
                    span = _otel_trace.get_current_span()
                    if span is not None:
                        span.set_attribute("workflow.run_id", wf['run_id'])
                        span.set_attribute("workflow.node_uid", wf['node_uid'])
                        span.set_attribute("iii.function.id", _fn_id)
                        span.set_attribute("workflow.runtime", "python")
                        if wf.get('trace_id'):
                            span.set_attribute("workflow.trace_id", wf['trace_id'])
                if has_workflow_meta:
                    await _emit_workflow_trace_event(_client, _fn_id, wf, "workflow.node.started")
                try:
                    # Execute handler with unwrapped input
                    result = await _h(actual_input)
                except Exception as e:
                    # Signal failure to workflow orchestrator if meta is present
                    if has_workflow_meta:
                        await _emit_workflow_trace_event(
                            _client,
                            _fn_id,
                            wf,
                            "workflow.node.failed",
                            {"error": str(e)},
                        )
                        try:
                            # Write error sentinel to state store so orchestrator can detect it
                            await _client.trigger_async({
                                'function_id': 'state::set',
                                'payload': {
                                    'scope': 'workflow_node_result',
                                    'key': f"{wf['run_id']}/{wf['node_uid']}",
                                    'value': {"__workflow_error__": str(e)},
                                },
                            })
                            # Wake orchestrator
                            await _client.trigger_async({
                                'function_id': 'workflow::node-completed',
                                'payload': {
                                    'run_id': wf['run_id'],
                                    'node_uid': wf['node_uid'],
                                    'trace_id': _current_trace_id_hex(),
                                    'function_id': _fn_id,
                                    'runtime': 'python',
                                },
                            })
                        except Exception as e2:
                            print(f"[nvent/workflow] error reporting failed: {e2}", flush=True)
                    raise e
                
                # Auto-emit workflow completion if _workflow metadata is present
                if has_workflow_meta:
                    await _emit_workflow_trace_event(_client, _fn_id, wf, "workflow.node.completed")
                    try:
                        print(f"[nvent/workflow] node {wf['node_uid']} completed, writing result", flush=True)
                        
                        # Write result to state
                        await _client.trigger_async({
                            'function_id': 'state::set',
                            'payload': {
                                'scope': 'workflow_node_result',
                                'key': f"{wf['run_id']}/{wf['node_uid']}",
                                'value': result,
                            },
                        })
                        
                        print(f"[nvent/workflow] result written, emitting completion event for {wf['node_uid']}", flush=True)
                        
                        # Emit completion event
                        await _client.trigger_async({
                            'function_id': 'workflow::node-completed',
                            'payload': {
                                'run_id': wf['run_id'],
                                'node_uid': wf['node_uid'],
                                'trace_id': _current_trace_id_hex(),
                                'function_id': _fn_id,
                                'runtime': 'python',
                            },
                        })
                        
                        print(f"[nvent/workflow] completion event emitted for {wf['node_uid']}", flush=True)
                    except Exception as e:
                        print(f"[nvent/workflow] completion failed: {e}", flush=True)
                
                return result
            return _wrapped

        wrapped = _make_wrapper_no_trigger(handler_fn, client, fn_id)
        client.register_function(fn_id, wrapped, metadata=metadata)

        workflow_subscribed = _register_workflow_subscriber(client, fn_id, workflow_cfg)
        if workflow_subscribed:
            print(f"[nvent] registered {fn_id!r} (0 trigger(s), workflow queue enabled)", flush=True)
        else:
            print(f"[nvent] registered {fn_id!r} (0 trigger(s))", flush=True)
        return

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

        def _make_wrapper_thin(_h, _is_http, _client):
            async def _wrapped(data):
                # Detect workflow orchestration metadata and unwrap input
                is_workflow = isinstance(data, dict) and '_workflow' in data
                wf = data.get('_workflow') if is_workflow else None
                has_workflow_meta = isinstance(wf, dict) and 'run_id' in wf and 'node_uid' in wf
                
                # Extract actual input (unwrap from workflow envelope)
                actual_input = data.get('input') if has_workflow_meta else data
                
                if has_workflow_meta and _HAS_OTEL:
                    span = _otel_trace.get_current_span()
                    if span is not None:
                        span.set_attribute("workflow.run_id", wf['run_id'])
                        span.set_attribute("workflow.node_uid", wf['node_uid'])
                        span.set_attribute("iii.function.id", _fn_id)
                        span.set_attribute("workflow.runtime", "python")
                        if wf.get('trace_id'):
                            span.set_attribute("workflow.trace_id", wf['trace_id'])
                if has_workflow_meta:
                    await _emit_workflow_trace_event(_client, _fn_id, wf, "workflow.node.started")
                # Wrap dict in HttpRequest for HTTP triggers
                input_data = ApiRequest(**actual_input) if (_is_http and isinstance(actual_input, dict)) else actual_input
                
                try:
                    result = await _h(input_data)
                except Exception as e:
                    # Signal failure to workflow orchestrator if meta is present
                    if has_workflow_meta:
                        await _emit_workflow_trace_event(
                            _client,
                            _fn_id,
                            wf,
                            "workflow.node.failed",
                            {"error": str(e)},
                        )
                        try:
                            # Write error sentinel to state store
                            await _client.trigger_async({
                                'function_id': 'state::set',
                                'payload': {
                                    'scope': 'workflow_node_result',
                                    'key': f"{wf['run_id']}/{wf['node_uid']}",
                                    'value': {"__workflow_error__": str(e)},
                                },
                            })
                            # Wake orchestrator
                            await _client.trigger_async({
                                'function_id': 'workflow::node-completed',
                                'payload': {
                                    'run_id': wf['run_id'],
                                    'node_uid': wf['node_uid'],
                                    'trace_id': _current_trace_id_hex(),
                                    'function_id': _fn_id,
                                    'runtime': 'python',
                                },
                            })
                        except Exception as e2:
                            print(f"[nvent/workflow] error reporting failed: {e2}", flush=True)
                    raise e
                
                # Auto-emit workflow completion if _workflow metadata is present
                if has_workflow_meta:
                    await _emit_workflow_trace_event(_client, _fn_id, wf, "workflow.node.completed")
                    try:
                        # Write result to state
                        await _client.trigger_async({
                            'function_id': 'state::set',
                            'payload': {
                                'scope': 'workflow_node_result',
                                'key': f"{wf['run_id']}/{wf['node_uid']}",
                                'value': result,
                            },
                        })
                        
                        # Emit completion event
                        await _client.trigger_async({
                            'function_id': 'workflow::node-completed',
                            'payload': {
                                'run_id': wf['run_id'],
                                'node_uid': wf['node_uid'],
                                'trace_id': _current_trace_id_hex(),
                                'function_id': _fn_id,
                                'runtime': 'python',
                            },
                        })
                    except Exception as e:
                        print(f"[nvent] workflow completion failed: {e}", flush=True)
                
                return result
            return _wrapped

        wrapped = _make_wrapper_thin(handler_fn, is_http, client)
        iii_trigger_type = "durable:subscriber" if t_type == "queue" else t_type
        client.register_function(function_id, wrapped, metadata=metadata)
        client.register_trigger({"type": iii_trigger_type, "function_id": function_id, "config": iii_cfg})
    _register_workflow_subscriber(client, fn_id, workflow_cfg)
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
        workflow_cfg = config_dict.get("workflow")
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
        workflow_cfg = meta.get("workflow")
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
        "workflow": workflow_cfg,
        "flows": flows,
        "enqueues": enqueues,
    }

    # If no triggers, register the function directly so it can be called by workflows
    if len(triggers) == 0:
        def _make_wrapper_no_trigger(_h, _fn_id, _hc, _stream_name, _client):
            async def _wrapped(data):
                # Detect workflow orchestration metadata and unwrap input
                is_workflow = isinstance(data, dict) and '_workflow' in data
                wf = data.get('_workflow') if is_workflow else None
                has_workflow_meta = isinstance(wf, dict) and 'run_id' in wf and 'node_uid' in wf
                
                # Extract actual input (unwrap from workflow envelope)
                actual_input = data.get('input') if has_workflow_meta else data

                workflow_logger = _ContextLogger(
                    _client,
                    _fn_id,
                    run_id=wf.get('run_id') if has_workflow_meta else None,
                    node_uid=wf.get('node_uid') if has_workflow_meta else None,
                    trace_id=wf.get('trace_id') if has_workflow_meta else None,
                ) if has_workflow_meta else None
                if has_workflow_meta and _HAS_OTEL:
                    span = _otel_trace.get_current_span()
                    if span is not None:
                        span.set_attribute("workflow.run_id", wf['run_id'])
                        span.set_attribute("workflow.node_uid", wf['node_uid'])
                        span.set_attribute("iii.function.id", _fn_id)
                        span.set_attribute("workflow.runtime", "python")
                        if wf.get('trace_id'):
                            span.set_attribute("workflow.trace_id", wf['trace_id'])
                if has_workflow_meta:
                    await _emit_workflow_trace_event(_client, _fn_id, wf, "workflow.node.started")
                try:
                    # Execute handler
                    if not _hc:
                        result = await _h(actual_input)
                    else:
                        ctx = FlowContext(_client, _fn_id, "invoke", actual_input, _stream_name, None, wf)
                        result = await _h(actual_input, ctx)
                    if workflow_logger:
                        await workflow_logger.flush()
                except Exception as e:
                    if has_workflow_meta:
                        await _emit_workflow_trace_event(
                            _client,
                            _fn_id,
                            wf,
                            "workflow.node.failed",
                            {"error": str(e)},
                        )
                    if workflow_logger:
                        await workflow_logger.flush()
                    # Signal failure to workflow orchestrator if meta is present
                    if has_workflow_meta:
                        try:
                            # Write error sentinel to state store
                            await _client.trigger_async({
                                'function_id': 'state::set',
                                'payload': {
                                    'scope': 'workflow_node_result',
                                    'key': f"{wf['run_id']}/{wf['node_uid']}",
                                    'value': {"__workflow_error__": str(e)},
                                },
                            })
                            # Wake orchestrator
                            await _client.trigger_async({
                                'function_id': 'workflow::node-completed',
                                'payload': {
                                    'run_id': wf['run_id'],
                                    'node_uid': wf['node_uid'],
                                    'trace_id': _current_trace_id_hex(),
                                    'function_id': _fn_id,
                                    'runtime': 'python',
                                },
                            })
                        except Exception as e2:
                            print(f"[nvent/workflow] error reporting failed: {e2}", flush=True)
                    raise e
                
                # Auto-emit workflow completion if _workflow metadata is present
                if has_workflow_meta:
                    await _emit_workflow_trace_event(_client, _fn_id, wf, "workflow.node.completed")
                    try:
                        # Write result to state
                        await _client.trigger_async({
                            'function_id': 'state::set',
                            'payload': {
                                'scope': 'workflow_node_result',
                                'key': f"{wf['run_id']}/{wf['node_uid']}",
                                'value': result,
                            },
                        })
                        
                        # Emit completion event
                        await _client.trigger_async({
                            'function_id': 'workflow::node-completed',
                            'payload': {
                                'run_id': wf['run_id'],
                                'node_uid': wf['node_uid'],
                                'trace_id': _current_trace_id_hex(),
                                'function_id': _fn_id,
                                'runtime': 'python',
                            },
                        })
                    except Exception as e:
                        print(f"[nvent] workflow completion failed: {e}", flush=True)
                
                return result
            return _wrapped

        wrapped = _make_wrapper_no_trigger(handler_fn, fn_id, has_ctx, stream_name, client)
        client.register_function(fn_id, wrapped, metadata=metadata)

        workflow_subscribed = _register_workflow_subscriber(client, fn_id, workflow_cfg)
        if workflow_subscribed:
            print(f"[nvent] registered {fn_id!r} (0 trigger(s), workflow queue enabled)", flush=True)
        else:
            print(f"[nvent] registered {fn_id!r} (0 trigger(s))", flush=True)
        return

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

        def _make_wrapper(_h, _is_http, _t_type, _fn_id, _hc, _stream_name, _client):
            async def _wrapped(data):
                # Detect workflow orchestration metadata BEFORE stream processing
                is_workflow = isinstance(data, dict) and '_workflow' in data
                wf = data.get('_workflow') if is_workflow else None
                has_workflow_meta = isinstance(wf, dict) and 'run_id' in wf and 'node_uid' in wf
                
                # Extract actual input (unwrap from workflow envelope)
                working_data = data.get('input') if has_workflow_meta else data
                
                # Process stream metadata
                inherited_group = None
                effective_stream = _stream_name
                clean_data = working_data
                if isinstance(working_data, dict) and _NVENT_STREAM_KEY in working_data:
                    nvent_stream = working_data[_NVENT_STREAM_KEY]
                    if isinstance(nvent_stream, dict):
                        inherited_group = nvent_stream.get('groupId')
                        effective_stream = nvent_stream.get('name') or _stream_name
                    clean_data = {k: v for k, v in working_data.items() if k != _NVENT_STREAM_KEY}

                workflow_logger = _ContextLogger(
                    _client,
                    _fn_id,
                    run_id=wf.get('run_id') if has_workflow_meta else None,
                    node_uid=wf.get('node_uid') if has_workflow_meta else None,
                    trace_id=wf.get('trace_id') if has_workflow_meta else None,
                ) if has_workflow_meta else None
                if has_workflow_meta and _HAS_OTEL:
                    span = _otel_trace.get_current_span()
                    if span is not None:
                        span.set_attribute("workflow.run_id", wf['run_id'])
                        span.set_attribute("workflow.node_uid", wf['node_uid'])
                        span.set_attribute("iii.function.id", _fn_id)
                        span.set_attribute("workflow.runtime", "python")
                        if wf.get('trace_id'):
                            span.set_attribute("workflow.trace_id", wf['trace_id'])
                if has_workflow_meta:
                    await _emit_workflow_trace_event(_client, _fn_id, wf, "workflow.node.started")
                
                # Wrap dict in HttpRequest for HTTP triggers
                input_data = ApiRequest(**clean_data) if (_is_http and isinstance(clean_data, dict)) else clean_data
                try:
                    if not _hc:
                        result = await _h(input_data)
                    else:
                        ctx = FlowContext(_client, _fn_id, _t_type, input_data, effective_stream, inherited_group, wf)
                        result = await _h(input_data, ctx)
                    if workflow_logger:
                        await workflow_logger.flush()
                except Exception as e:
                    if has_workflow_meta:
                        await _emit_workflow_trace_event(
                            _client,
                            _fn_id,
                            wf,
                            "workflow.node.failed",
                            {"error": str(e)},
                        )
                    if workflow_logger:
                        await workflow_logger.flush()
                    raise
                
                # Auto-emit workflow completion if _workflow metadata is present
                if has_workflow_meta:
                    await _emit_workflow_trace_event(_client, _fn_id, wf, "workflow.node.completed")
                    try:
                        # Write result to state
                        await _client.trigger_async({
                            'function_id': 'state::set',
                            'payload': {
                                'scope': 'workflow_node_result',
                                'key': f"{wf['run_id']}/{wf['node_uid']}",
                                'value': result,
                            },
                        })
                        
                        # Emit completion event
                        await _client.trigger_async({
                            'function_id': 'workflow::node-completed',
                            'payload': {
                                'run_id': wf['run_id'],
                                'node_uid': wf['node_uid'],
                                'trace_id': _current_trace_id_hex(),
                                'function_id': _fn_id,
                                'runtime': 'python',
                            },
                        })
                    except Exception as e:
                        print(f"[nvent] workflow completion failed: {e}", flush=True)
                
                return result
            return _wrapped

        wrapped = _make_wrapper(handler_fn, is_http, t_type, fn_id, has_ctx, stream_name, client)
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

    _register_workflow_subscriber(client, fn_id, workflow_cfg)

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
