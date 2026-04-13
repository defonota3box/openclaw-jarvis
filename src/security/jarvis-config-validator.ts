/**
 * Jarvis-side hard-fail config validator (Phase 1d — H4/H5/H10 hardening).
 *
 * Called at gateway startup before any plugin or messaging channel starts.
 * Throws an aggregate Error listing all violations so the operator sees the
 * full picture in one go.  This function is intentionally read-only: it never
 * modifies the config.
 *
 * H4 — Sandbox enforcement:
 *   agents.defaults.sandbox.mode === "off" while any messaging channel is
 *   enabled → prompt injection can reach host exec without a sandbox boundary.
 *
 * H5 — Auth mode gate:
 *   gateway.auth.mode === "none" while any messaging channel is enabled →
 *   unauthenticated gateway is acceptable only for loopback dev, never with
 *   live messaging.
 *
 * H10 — Auto-allow skills gate:
 *   tools.exec.autoAllowSkills === true → widens exec trust beyond the
 *   explicit allowlist regardless of which channels are enabled.
 */

import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Canonical messaging channel plugin IDs that bring external inbound traffic. */
const MESSAGING_CHANNEL_IDS = [
  "whatsapp",
  "telegram",
  "discord",
  "signal",
  "slack",
  "imessage",
  "bluebubbles",
] as const;

/**
 * Returns true if at least one messaging channel plugin is enabled in the
 * given config.  A channel is considered enabled unless its entry explicitly
 * sets `enabled: false`.
 */
function hasEnabledMessagingChannel(cfg: OpenClawConfig): boolean {
  const entries = cfg.plugins?.entries;
  if (!entries) {
    // No entries at all — treat as "no channel explicitly enabled".
    return false;
  }
  return MESSAGING_CHANNEL_IDS.some((id) => {
    const entry = entries[id];
    // If the entry is present and enabled !== false, the channel is on.
    return entry !== undefined && entry.enabled !== false;
  });
}

/**
 * Validates Jarvis hardening invariants (H4, H5, H10) against the supplied
 * OpenClaw config.
 *
 * @throws {Error} Aggregate error listing all violations if any are found.
 */
export function validateJarvisHardening(cfg: OpenClawConfig): void {
  const violations: string[] = [];

  // H4 — Sandbox enforcement
  const sandboxMode = cfg.agents?.defaults?.sandbox?.mode;
  if (sandboxMode === "off" && hasEnabledMessagingChannel(cfg)) {
    violations.push(
      "[H4] agents.defaults.sandbox.mode is \"off\" while a messaging channel is enabled. " +
        "Set agents.defaults.sandbox.mode to \"non-main\" or \"all\" to prevent prompt " +
        "injection from reaching host exec without a sandbox boundary.",
    );
  }

  // H5 — Auth mode gate
  const gatewayAuthMode = cfg.gateway?.auth?.mode;
  if (gatewayAuthMode === "none" && hasEnabledMessagingChannel(cfg)) {
    violations.push(
      "[H5] gateway.auth.mode is \"none\" while a messaging channel is enabled. " +
        "Unauthenticated gateway access is only acceptable for loopback dev; set " +
        "gateway.auth.mode to \"token\" (or another authenticating mode) for any " +
        "deployment with live messaging channels.",
    );
  }

  // H10 — Auto-allow skills gate
  // autoAllowSkills may appear in tools.exec (future schema) or agent overrides.
  // We check the top-level tools.exec path specified by the threat model.
  // Cast through unknown to handle schema evolution without breaking the type check.
  const execCfg = cfg.tools?.exec as (typeof cfg.tools.exec & { autoAllowSkills?: boolean }) | undefined;
  if (execCfg?.autoAllowSkills === true) {
    violations.push(
      "[H10] tools.exec.autoAllowSkills is true. This widens exec trust beyond the " +
        "explicit allowlist and is rejected in Jarvis deployments. Set " +
        "tools.exec.autoAllowSkills to false and use an explicit exec allowlist.",
    );
  }

  if (violations.length > 0) {
    throw new Error(
      "Jarvis config hardening check failed — fix all violations before starting the gateway:\n\n" +
        violations.map((v, i) => `${i + 1}. ${v}`).join("\n\n"),
    );
  }
}
