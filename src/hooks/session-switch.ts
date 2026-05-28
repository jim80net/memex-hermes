// Hermes.session-switch (R4) — re-scope subsequent writes/reads to the new
// session id. When `reset=true`, flush per-session in-memory buffers
// (last-prefetch buffer, cached system-prompt block, embedding cache).
// memory-mtimes intentionally persist across resets because they're a global
// "have I seen this disk mtime before?" tracker, not session-scoped.

import type { HermesSessionSwitchArgs, HermesSessionSwitchOutput } from "../core/envelope.ts";
import { setSessionId } from "../state.ts";

export function handleSessionSwitch(
  args: HermesSessionSwitchArgs | undefined,
): HermesSessionSwitchOutput {
  if (!args) return { ok: true };
  setSessionId(args.new_session_id, args.reset === true);
  return { ok: true };
}
