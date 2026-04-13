# jarvis-approval-gate

Gates configured tool calls behind operator approval routed through the Jarvis policy service.

## How it works

Subscribes to `before_tool_call`. When a tool name matches a configured rule, returns OpenClaw's built-in `requireApproval` directive — the host agent loop suspends the tool call and waits for an approval decision.

Two policy-service notifications fire:
1. **`POST /approvals/pending`** — fire-and-forget, sent when the gate triggers (so the policy service / PWA can surface a UI prompt to the operator)
2. **`POST /approvals/resolved`** — fired in `onResolution` callback with the operator's decision (`allow-once` / `allow-always` / `deny` / `timeout` / `cancelled`)

OpenClaw's built-in `requireApproval` machinery handles the actual wait, cancellation, and timeout — no custom queue needed.

## Sidecar API contract

```
POST ${policySvcUrl}/approvals/pending
  body: { requestId, toolName, riskClass, agentId, channelId, sessionKey, sessionId,
          paramsHash, approvalTimeoutMs, timeoutBehavior, ts }

POST ${policySvcUrl}/approvals/resolved
  body: { requestId, toolName, riskClass, agentId, channelId, decision, ts }
```

`paramsHash` is a SHA-256 of the JSON-serialized tool params; raw params are NOT sent (privacy + log-injection safety).

## Configuration

```jsonc
// openclaw.json
{
  "plugins": {
    "entries": {
      "jarvis-approval-gate": {
        "enabled": true,
        "config": {
          "policySvcUrl": "http://policy-svc:3036",
          "httpTimeoutMs": 2000,
          "approvalTimeoutMs": 300000,
          "timeoutBehavior": "deny",
          "rules": [
            {
              "toolName": "run_command",
              "riskClass": "external_action",
              "title": "Approve shell command",
              "severity": "warning"
            },
            {
              "toolNamePattern": "^send_(message|email)$",
              "riskClass": "external_action",
              "title": "Approve outbound message",
              "severity": "warning"
            },
            {
              "toolName": "transfer_funds",
              "riskClass": "financial",
              "title": "Approve money transfer",
              "severity": "critical"
            }
          ]
        }
      }
    }
  }
}
```

## Defaults

- `approvalTimeoutMs`: 300_000 (5 min); hard ceiling 600_000 (matches OpenClaw `MAX_PLUGIN_APPROVAL_TIMEOUT_MS`)
- `timeoutBehavior`: `deny` (Jarvis safety policy — unattended approvals never auto-allow)
- Empty `rules`: plugin loads but is inactive (logged at startup)

## Failure modes

- Policy-service unreachable on `/approvals/pending`: operator may not see the prompt in real time, but the agent still waits and times out per `timeoutBehavior`. The user-facing impact is "approval prompt may be delayed."
- Policy-service unreachable on `/approvals/resolved`: decision was made (allow/deny is honoured by host) but downstream audit log misses the entry. The decision still affects the tool call.
- Both POSTs are bounded by `httpTimeoutMs` and never throw.

## Trust posture

This plugin enforces the H6/H1 trust assumption that channel content cannot autonomously trigger sensitive tool calls. Combined with the `jarvis-pre-prompt` channel-trust block, this provides defense-in-depth: even if the model were tricked into attempting a tool call, the gate forces an explicit operator decision.
