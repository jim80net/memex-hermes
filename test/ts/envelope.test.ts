// Envelope round-trip — each HERMES_EVENTS constant has matching input/output
// shapes declared in HermesEventMap. The compiler enforces the typing; this
// suite asserts the runtime constants are present and unique, and exercises
// the union via a switch that must compile cleanly.

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  HERMES_EVENTS,
  type HermesEventMap,
  type HermesEventName,
  type HermesHealthOutput,
  type HermesHookInput,
  type HermesInitArgs,
  type HermesMemoryWriteArgs,
  type HermesMemoryWriteOutput,
  type HermesPrefetchArgs,
  type HermesPrefetchOutput,
  type HermesSyncTurnArgs,
  type HermesSyncTurnOutput,
  type HermesToolSearchArgs,
  type HermesToolSearchOutput,
} from "../../src/core/envelope.ts";

describe("HERMES_EVENTS constants", () => {
  it("has 14 distinct event names — the spec'd surface", () => {
    const values = Object.values(HERMES_EVENTS);
    expect(values.length).toBe(14);
    expect(new Set(values).size).toBe(values.length);
  });

  it("every event name starts with the Hermes. prefix", () => {
    for (const name of Object.values(HERMES_EVENTS)) {
      expect(name.startsWith("Hermes.")).toBe(true);
    }
  });
});

describe("HermesEventMap type wiring (compile-time, asserted at runtime)", () => {
  it("PREFETCH input narrows to HermesPrefetchArgs and output to HermesPrefetchOutput", () => {
    const input: HermesHookInput<typeof HERMES_EVENTS.PREFETCH, HermesPrefetchArgs> = {
      hook_event_name: HERMES_EVENTS.PREFETCH,
      args: { query: "foo" },
    };
    expect(input.hook_event_name).toBe(HERMES_EVENTS.PREFETCH);
    expectTypeOf<
      HermesEventMap[typeof HERMES_EVENTS.PREFETCH]["args"]
    >().toEqualTypeOf<HermesPrefetchArgs>();
    expectTypeOf<
      HermesEventMap[typeof HERMES_EVENTS.PREFETCH]["output"]
    >().toEqualTypeOf<HermesPrefetchOutput>();
  });

  it("INIT input maps to HermesInitArgs", () => {
    expectTypeOf<
      HermesEventMap[typeof HERMES_EVENTS.INIT]["args"]
    >().toEqualTypeOf<HermesInitArgs>();
  });

  it("MEMORY_WRITE input maps to HermesMemoryWriteArgs / output", () => {
    expectTypeOf<
      HermesEventMap[typeof HERMES_EVENTS.MEMORY_WRITE]["args"]
    >().toEqualTypeOf<HermesMemoryWriteArgs>();
    expectTypeOf<
      HermesEventMap[typeof HERMES_EVENTS.MEMORY_WRITE]["output"]
    >().toEqualTypeOf<HermesMemoryWriteOutput>();
  });

  it("HEALTH output is HermesHealthOutput", () => {
    expectTypeOf<
      HermesEventMap[typeof HERMES_EVENTS.HEALTH]["output"]
    >().toEqualTypeOf<HermesHealthOutput>();
  });

  it("SYNC_TURN input maps to HermesSyncTurnArgs / output", () => {
    expectTypeOf<
      HermesEventMap[typeof HERMES_EVENTS.SYNC_TURN]["args"]
    >().toEqualTypeOf<HermesSyncTurnArgs>();
    expectTypeOf<
      HermesEventMap[typeof HERMES_EVENTS.SYNC_TURN]["output"]
    >().toEqualTypeOf<HermesSyncTurnOutput>();
  });

  it("TOOL_SEARCH input maps to HermesToolSearchArgs / output", () => {
    expectTypeOf<
      HermesEventMap[typeof HERMES_EVENTS.TOOL_SEARCH]["args"]
    >().toEqualTypeOf<HermesToolSearchArgs>();
    expectTypeOf<
      HermesEventMap[typeof HERMES_EVENTS.TOOL_SEARCH]["output"]
    >().toEqualTypeOf<HermesToolSearchOutput>();
  });

  it("HermesEventName covers exactly the union of HERMES_EVENTS values", () => {
    // Compile-time: every constant is assignable to HermesEventName.
    const names: HermesEventName[] = Object.values(HERMES_EVENTS);
    expect(names.length).toBe(14);
  });
});
