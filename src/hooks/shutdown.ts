// Hermes.shutdown — bounded drain of any in-memory accumulator. Spec
// requirement: the response is `{}` within 1 second under normal conditions.
//
// We deliberately do NOT touch the embedding cache or session block — those
// are valid for the next invocation. Telemetry & memory-mtimes writes are
// already serialized through withFileLock; nothing else is queued. This
// handler is therefore mostly an acknowledgement, with a hook for any future
// in-memory queues that need draining.

import type { Logger } from "@jim80net/memex-core";
import type { HermesShutdownOutput } from "../core/envelope.ts";

export function handleShutdown(logger?: Logger): HermesShutdownOutput {
  logger?.info("memex-hermes[shutdown]: clean exit");
  return { ok: true };
}
