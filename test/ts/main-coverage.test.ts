// Compile-time enforcement that main.ts's dispatch switch covers every
// HERMES_EVENTS constant. We can't directly inspect a TypeScript switch from
// tests, so instead we depend on the exhaustiveness guard exported by main.ts
// — if a case were missing, the switch's `default` arm would not narrow the
// union to `never` and dispatch would fail to typecheck.
//
// We also assert at runtime that dispatching an unknown event_name produces a
// structured error response (per hermes-engine-events R1 "Unknown Hermes.*
// event returns a structured error").

import { describe, expect, it } from "vitest";
import type { HermesConfig } from "../../src/core/config.ts";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { HERMES_EVENTS } from "../../src/core/envelope.ts";
import type { HermesPaths } from "../../src/core/hermes-paths.ts";
import { _exhaustivenessGuard, dispatch } from "../../src/main.ts";
import { makeFakeIndexAndProvider, makeFakePaths } from "./_helpers.ts";

describe("main.ts exhaustiveness", () => {
  it("exposes an exhaustiveness guard that accepts every HERMES_EVENTS constant", () => {
    for (const name of Object.values(HERMES_EVENTS)) {
      expect(_exhaustivenessGuard(name)).toBe(name);
    }
  });
});

describe("main.dispatch — unknown event returns structured error", () => {
  it("returns {error:'unknown_event', hook_event_name:<original>}", async () => {
    const paths: HermesPaths = makeFakePaths();
    const config: HermesConfig = { ...DEFAULT_CONFIG, enabled: true };
    const { index, provider } = makeFakeIndexAndProvider();
    const result = (await dispatch(
      {
        hook_event_name: "Hermes.unknown-event" as never,
      },
      { config, paths, index, provider },
    )) as { error?: string; hook_event_name?: string };

    expect(result.error).toBe("unknown_event");
    expect(result.hook_event_name).toBe("Hermes.unknown-event");
  });
});

describe("main.dispatch — disabled config returns empty object", () => {
  it("short-circuits when config.enabled is false", async () => {
    const paths: HermesPaths = makeFakePaths();
    const config: HermesConfig = { ...DEFAULT_CONFIG, enabled: false };
    const result = await dispatch({ hook_event_name: HERMES_EVENTS.HEALTH }, { config, paths });
    expect(result).toEqual({});
  });
});
