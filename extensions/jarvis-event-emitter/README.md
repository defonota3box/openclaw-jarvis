# jarvis-event-emitter

OpenClaw plugin that emits lifecycle events for consumption by the Jarvis cognition layer.

## What it does

Subscribes to five OpenClaw lifecycle hooks and emits a structured event for each:

| Hook | Purpose |
|---|---|
| `message_received` | A channel inbound message arrived (Telegram, Discord, etc.) |
| `message_sent` | An outbound message was delivered |
| `before_agent_start` | An agent session is about to start (proxy for "skill started") |
| `agent_end` | An agent session ended (success/duration available) |
| `before_tool_call` | A tool was about to be invoked. Tagged `meta.execInvocation = true` for `run_command` / `exec*` tools |

Each event is written as a single-line JSON object (JSONL) to stdout — captured by Docker logging — and optionally POSTed to an HTTP sink for direct ingestion by the cognition sidecar.

## Schema

```jsonc
{
  "schema": "jarvis-event/v1",
  "event": "message_received",
  "ts": "2026-04-13T20:31:55.123Z",
  "channelId": "telegram",
  "agentId": "main",
  "sessionId": "sess_abc123",
  "sessionKey": "telegram:1234567",
  "modelId": "claude-sonnet-4-6",
  "modelProviderId": "anthropic",
  "trigger": "user-message",
  "payloadHash": "f3a1...",   // SHA-256 of the event payload (when redactPayloadHash=true)
  "payload": null,            // raw payload only when redactPayloadHash=false
  "meta": { "execInvocation": true }   // optional per-event metadata
}
```

## Configuration

```jsonc
// openclaw.json
{
  "plugins": {
    "entries": {
      "jarvis-event-emitter": {
        "enabled": true,
        "config": {
          "stdoutEnabled": true,
          "httpSinkUrl": "http://cognition-svc:3030/events",
          "httpTimeoutMs": 1000,
          "redactPayloadHash": true,
          "subscribeEvents": [
            "message_received",
            "message_sent",
            "before_agent_start",
            "agent_end",
            "before_tool_call"
          ]
        }
      }
    }
  }
}
```

All config keys are optional. Defaults: enabled, stdout-on, all five events subscribed, payloads hashed.

## Security

- **`redactPayloadHash: true`** (default): message bodies and exec params are SHA-256 hashed before emission. Cognition can correlate via hash but never sees plaintext.
- HTTP sink failures are logged to stderr and swallowed — the hook chain stays alive.
- HTTP POSTs run fire-and-forget (not awaited) to avoid adding latency to the agent loop.
- `httpTimeoutMs` capped at 5s.

## Operational notes

- Stdout JSONL is the reliable path; HTTP sink is convenience for low-latency ingest.
- The `meta.execInvocation` flag identifies host shell invocations — H9 audit log can filter on this.
- `payload` is omitted entirely when hashing is on; switch to `redactPayloadHash: false` for debugging only.
