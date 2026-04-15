import crypto from "node:crypto";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_HTTP_TIMEOUT_MS = 1000;
const DEFAULT_SUBSCRIBE_EVENTS = [
  "message_received",
  "message_sent",
  "before_agent_start",
  "agent_end",
  "before_tool_call",
] as const;

type SubscribableEvent = (typeof DEFAULT_SUBSCRIBE_EVENTS)[number];

type JarvisEventEmitterConfig = {
  enabled?: boolean;
  stdoutEnabled?: boolean;
  httpSinkUrl?: string;
  httpTimeoutMs?: number;
  redactPayloadHash?: boolean;
  subscribeEvents?: SubscribableEvent[];
};

type EmittedEvent = {
  schema: "jarvis-event/v1";
  event: SubscribableEvent;
  ts: string;
  channelId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  modelId?: string;
  modelProviderId?: string;
  trigger?: string;
  payloadHash?: string;
  payload?: unknown;
  meta?: Record<string, unknown>;
};

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  } catch {
    return "";
  }
}

function hashPayload(payload: unknown): string | undefined {
  const s = safeStringify(payload);
  if (!s) return undefined;
  return sha256(s);
}

function resolveConfig(raw: unknown): Required<
  Omit<JarvisEventEmitterConfig, "httpSinkUrl">
> & { httpSinkUrl: string | undefined } {
  const cfg = (raw ?? {}) as JarvisEventEmitterConfig;
  return {
    enabled: cfg.enabled !== false,
    stdoutEnabled: cfg.stdoutEnabled !== false,
    httpSinkUrl:
      typeof cfg.httpSinkUrl === "string" && cfg.httpSinkUrl.trim().length > 0
        ? cfg.httpSinkUrl.trim()
        : undefined,
    httpTimeoutMs:
      typeof cfg.httpTimeoutMs === "number" ? cfg.httpTimeoutMs : DEFAULT_HTTP_TIMEOUT_MS,
    redactPayloadHash: cfg.redactPayloadHash !== false,
    subscribeEvents:
      Array.isArray(cfg.subscribeEvents) && cfg.subscribeEvents.length > 0
        ? cfg.subscribeEvents
        : Array.from(DEFAULT_SUBSCRIBE_EVENTS),
  };
}

async function postToSink(
  url: string,
  payload: EmittedEvent,
  timeoutMs: number,
): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = process.env.JARVIS_AUDIT_TOKEN;
    if (token) headers["x-audit-token"] = token;
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    // Defensive: never throw from a hook handler — break the hook chain otherwise.
    process.stderr.write(
      `[jarvis-event-emitter] HTTP sink POST failed: ${(err as Error)?.message ?? err}\n`,
    );
  } finally {
    clearTimeout(t);
  }
}

function emit(
  cfg: ReturnType<typeof resolveConfig>,
  event: EmittedEvent,
): void {
  if (cfg.stdoutEnabled) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
  if (cfg.httpSinkUrl) {
    // Fire-and-forget; do NOT await (hooks must remain low-latency).
    void postToSink(cfg.httpSinkUrl, event, cfg.httpTimeoutMs);
  }
}

function buildBaseEvent(
  cfg: ReturnType<typeof resolveConfig>,
  name: SubscribableEvent,
  ctx: Record<string, unknown> | undefined,
  payload: unknown,
  meta?: Record<string, unknown>,
): EmittedEvent {
  const payloadHash = cfg.redactPayloadHash ? hashPayload(payload) : undefined;
  return {
    schema: "jarvis-event/v1",
    event: name,
    ts: new Date().toISOString(),
    channelId: ctx?.channelId as string | undefined,
    agentId: ctx?.agentId as string | undefined,
    sessionId: ctx?.sessionId as string | undefined,
    sessionKey: ctx?.sessionKey as string | undefined,
    modelId: ctx?.modelId as string | undefined,
    modelProviderId: ctx?.modelProviderId as string | undefined,
    trigger: ctx?.trigger as string | undefined,
    payloadHash,
    payload: cfg.redactPayloadHash ? undefined : payload,
    meta,
  };
}

export default definePluginEntry({
  id: "jarvis-event-emitter",
  name: "Jarvis Event Emitter",
  description:
    "Emits OpenClaw lifecycle events to stdout (JSONL) and optionally POSTs to an HTTP sink.",
  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig);
    if (!cfg.enabled) {
      process.stderr.write("[jarvis-event-emitter] disabled via config; not subscribing.\n");
      return;
    }

    const subscribed = new Set<SubscribableEvent>(cfg.subscribeEvents);

    if (subscribed.has("message_received")) {
      api.on("message_received", async (event, ctx) => {
        emit(cfg, buildBaseEvent(cfg, "message_received", ctx, event));
      });
    }

    if (subscribed.has("message_sent")) {
      api.on("message_sent", async (event, ctx) => {
        emit(cfg, buildBaseEvent(cfg, "message_sent", ctx, event));
      });
    }

    if (subscribed.has("before_agent_start")) {
      api.on("before_agent_start", async (event, ctx) => {
        emit(cfg, buildBaseEvent(cfg, "before_agent_start", ctx, event));
      });
    }

    if (subscribed.has("agent_end")) {
      api.on("agent_end", async (event, ctx) => {
        emit(cfg, buildBaseEvent(cfg, "agent_end", ctx, event));
      });
    }

    if (subscribed.has("before_tool_call")) {
      api.on("before_tool_call", async (event, ctx) => {
        // Tag exec invocations specifically so cognition + audit can filter on them
        // without parsing the raw tool name on the consumer side.
        const ev = event as { toolName?: string };
        const meta: Record<string, unknown> = {};
        if (
          typeof ev.toolName === "string" &&
          (ev.toolName === "run_command" || ev.toolName.startsWith("exec"))
        ) {
          meta.execInvocation = true;
        }
        emit(cfg, buildBaseEvent(cfg, "before_tool_call", ctx, event, meta));
      });
    }

    process.stderr.write(
      `[jarvis-event-emitter] subscribed to ${cfg.subscribeEvents.join(", ")}; ` +
        `stdout=${cfg.stdoutEnabled} httpSink=${cfg.httpSinkUrl ?? "off"} ` +
        `redact=${cfg.redactPayloadHash}\n`,
    );
  },
});
