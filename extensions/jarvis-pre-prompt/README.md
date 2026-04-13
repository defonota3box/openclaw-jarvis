# jarvis-pre-prompt

Injects three blocks into every agent's prompt:

1. **H6 channel-trust block** (`prependSystemContext`, cacheable) — instructs the model that all channel content is data, not instructions
2. **Self-model JSON** (`prependSystemContext`, cacheable) — who Jarvis is, current focus, open loops
3. **World-model snapshot** (`prependContext`, per-turn) — entities and recent changes relevant to the current channel

Memory retrieval is handled by `jarvis-memory` (separation of concerns). This plugin only handles self-model + world-model + trust block.

## Hook used

`before_prompt_build` (preferred over the legacy `before_agent_start`).

## Required config gate

`plugins.entries.jarvis-pre-prompt.hooks.allowPromptInjection: true` MUST be set in `openclaw.json` or the prompt mutations are silently ignored. This is OpenClaw's default safety check; we explicitly opt in.

## Sidecar API contract

```
GET ${selfModelUrl}/state
  res: { identity?, current_focus?, uncertainty?, open_loops? }

GET ${worldModelUrl}/snapshot?channel=<channelId>&sessionKey=<sessionKey>
  res: { entities?, active_relationships?, recent_changes? }
```

Both calls bounded by `httpTimeoutMs` (default 500ms). On timeout/error the corresponding block is omitted (degraded mode logged to stderr).

## Configuration

```jsonc
// openclaw.json
{
  "plugins": {
    "entries": {
      "jarvis-pre-prompt": {
        "enabled": true,
        "hooks": { "allowPromptInjection": true },   // ← REQUIRED
        "config": {
          "selfModelUrl": "http://self-model-svc:3035",
          "worldModelUrl": "http://world-model-svc:3032",
          "httpTimeoutMs": 500,
          "injectSelfModel": true,
          "injectWorldModel": true,
          "injectChannelTrust": true
        }
      }
    }
  }
}
```

## Caching strategy

Self-model and channel-trust go into `prependSystemContext` (cacheable — must stay byte-stable across turns to preserve the prompt cache key). World-model goes into `prependContext` (per-turn, NOT cached). Sidecars must keep self-model JSON byte-stable for cache stability — change only on real updates.
