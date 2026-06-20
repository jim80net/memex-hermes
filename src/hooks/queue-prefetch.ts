// Hermes.queue-prefetch — warm the embedding model and pre-compute the query
// embedding so the next Hermes.prefetch can skip the model-load + embed
// hops. The embedding lands in the process-state cache keyed by the literal
// query string for `cacheTimeMs`.

import type { EmbeddingProvider, Logger } from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type { HermesEmptyOutput, HermesQueuePrefetchArgs } from "../core/envelope.ts";
import { cacheQueryEmbedding } from "../state.ts";

export async function handleQueuePrefetch(
  args: HermesQueuePrefetchArgs | undefined,
  provider: EmbeddingProvider,
  config: HermesConfig,
  logger?: Logger,
): Promise<HermesEmptyOutput> {
  // Force the model to load even on an empty query so the next call to
  // provider.embed() inside prefetch is a hot path.
  try {
    await provider.embed([""]);
  } catch (err) {
    logger?.warn(`memex-hermes[queue-prefetch]: model warm-up failed: ${errMsg(err)}`);
  }

  const query = args?.query?.trim();
  if (!query) return {};

  try {
    const [embedding] = await provider.embed([query]);
    if (embedding) {
      cacheQueryEmbedding(query, embedding, config.cacheTimeMs);
    }
  } catch (err) {
    logger?.warn(`memex-hermes[queue-prefetch]: embed failed: ${errMsg(err)}`);
  }
  return {};
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
