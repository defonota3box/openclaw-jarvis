import crypto from "node:crypto";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_POLICY_SVC_URL = "http://policy-svc:3036";
const DEFAULT_HTTP_TIMEOUT_MS = 2000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_APPROVAL_TIMEOUT_MS = 600_000; // hard ceiling matches OpenClaw's MAX_PLUGIN_APPROVAL_TIMEOUT_MS

type RiskClass =
  | "data_read"
  | "data_write"
  | "external_action"
  | "destructive"
  | "financial"
  | "deploy";

type Severity = "info" | "warning" | "critical";

type ApprovalRule = {
  toolName?: string;
  toolNamePattern?: string;
  riskClass?: RiskClass;
  title?: string;
  description?: string;
  severity?: Severity;
};

type CompiledRule = ApprovalRule & {
  // Pre-compiled regex when toolNamePattern was supplied; matches() returns true if rule applies.
  matches: (toolName: string) => boolean;
};

type JarvisApprovalGateConfig = {
  policySvcUrl?: string;
  httpTimeoutMs?: number;
  approvalTimeoutMs?: number;
  timeoutBehavior?: "allow" | "deny";
  rules?: ApprovalRule[];
};

type ResolvedConfig = {
  policySvcUrl: string;
  httpTimeoutMs: number;
  approvalTimeoutMs: number;
  timeoutBehavior: "allow" | "deny";
  compiledRules: CompiledRule[];
};

function compileRule(rule: ApprovalRule): CompiledRule | undefined {
  if (rule.toolName) {
    const exact = rule.toolName;
    return { ...rule, matches: (n) => n === exact };
  }
  if (rule.toolNamePattern) {
    try {
      const re = new RegExp(rule.toolNamePattern);
      return { ...rule, matches: (n) => re.test(n) };
    } catch {
      process.stderr.write(
        `[jarvis-approval-gate] invalid toolNamePattern, skipping rule: ${rule.toolNamePattern}\n`,
      );
      return undefined;
    }
  }
  return undefined;
}

function resolveConfig(raw: unknown): ResolvedConfig {
  const cfg = (raw ?? {}) as JarvisApprovalGateConfig;
  const compiledRules = Array.isArray(cfg.rules)
    ? (cfg.rules.map(compileRule).filter(Boolean) as CompiledRule[])
    : [];
  const requested = typeof cfg.approvalTimeoutMs === "number"
    ? cfg.approvalTimeoutMs
    : DEFAULT_APPROVAL_TIMEOUT_MS;
  return {
    policySvcUrl:
      typeof cfg.policySvcUrl === "string" && cfg.policySvcUrl.trim().length > 0
        ? cfg.policySvcUrl.trim().replace(/\/+$/, "")
        : DEFAULT_POLICY_SVC_URL,
    httpTimeoutMs:
      typeof cfg.httpTimeoutMs === "number" ? cfg.httpTimeoutMs : DEFAULT_HTTP_TIMEOUT_MS,
    approvalTimeoutMs: Math.min(requested, MAX_APPROVAL_TIMEOUT_MS),
    timeoutBehavior: cfg.timeoutBehavior === "allow" ? "allow" : "deny",
    compiledRules,
  };
}

function findMatchingRule(
  cfg: ResolvedConfig,
  toolName: string,
): CompiledRule | undefined {
  return cfg.compiledRules.find((r) => r.matches(toolName));
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

async function postPolicyEvent(
  cfg: ResolvedConfig,
  endpoint: string,
  body: unknown,
): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.httpTimeoutMs);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = process.env.JARVIS_POLICY_TOKEN;
    if (token) headers["x-policy-token"] = token;
    await fetch(`${cfg.policySvcUrl}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    process.stderr.write(
      `[jarvis-approval-gate] policy service ${endpoint} failed: ${(err as Error)?.message ?? err}\n`,
    );
  } finally {
    clearTimeout(t);
  }
}

export default definePluginEntry({
  id: "jarvis-approval-gate",
  name: "Jarvis Approval Gate",
  description:
    "Gates configured tool calls behind operator approval via the Jarvis policy service.",
  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig);

    if (cfg.compiledRules.length === 0) {
      process.stderr.write(
        "[jarvis-approval-gate] no rules configured; plugin loaded but inactive.\n",
      );
      return;
    }

    process.stderr.write(
      `[jarvis-approval-gate] ${cfg.compiledRules.length} rule(s) loaded; ` +
        `policySvc=${cfg.policySvcUrl} approvalTimeout=${cfg.approvalTimeoutMs}ms ` +
        `onTimeout=${cfg.timeoutBehavior}\n`,
    );

    api.on("before_tool_call", async (event, ctx) => {
      const ev = event as { toolName?: string; params?: Record<string, unknown> };
      const toolName = typeof ev.toolName === "string" ? ev.toolName : "";
      if (!toolName) return undefined;

      const rule = findMatchingRule(cfg, toolName);
      if (!rule) return undefined; // not gated

      const requestId = crypto.randomUUID();
      const paramsHash = sha256(JSON.stringify(ev.params ?? {}));
      const title =
        rule.title ?? `Approve tool call: ${toolName}`;
      const description =
        rule.description ??
        `Tool '${toolName}' (risk: ${rule.riskClass ?? "unspecified"}) ` +
          `requested by agent ${ctx?.agentId ?? "?"} (session ${ctx?.sessionKey ?? "?"}).\n` +
          `Params hash: ${paramsHash.slice(0, 12)}...`;

      // Notify policy service that an approval is pending. Fire-and-forget;
      // OpenClaw's built-in machinery handles the actual wait.
      // PluginHookToolContext does NOT carry channelId — policy service can
      // derive channel from sessionKey (e.g. "telegram:12345") if needed.
      void postPolicyEvent(cfg, "/approvals/pending", {
        requestId,
        toolName,
        riskClass: rule.riskClass,
        agentId: ctx?.agentId,
        sessionKey: ctx?.sessionKey,
        sessionId: ctx?.sessionId,
        runId: ctx?.runId,
        paramsHash,
        approvalTimeoutMs: cfg.approvalTimeoutMs,
        timeoutBehavior: cfg.timeoutBehavior,
        ts: new Date().toISOString(),
      });

      return {
        requireApproval: {
          title,
          description,
          severity: rule.severity ?? "warning",
          timeoutMs: cfg.approvalTimeoutMs,
          timeoutBehavior: cfg.timeoutBehavior,
          pluginId: "jarvis-approval-gate",
          onResolution: async (decision: unknown) => {
            // Decision is one of: 'allow-once' | 'allow-always' | 'deny' | 'timeout' | 'cancelled'
            void postPolicyEvent(cfg, "/approvals/resolved", {
              requestId,
              toolName,
              riskClass: rule.riskClass,
              agentId: ctx?.agentId,
              sessionKey: ctx?.sessionKey,
              decision,
              ts: new Date().toISOString(),
            });
          },
        },
      };
    });
  },
});
