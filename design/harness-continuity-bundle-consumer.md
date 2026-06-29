# Design — memex consumption of the HarnessContinuityBundle (issue #18)

**Status:** strawman for cross-desk red-line (memex consumption half + a proposed
`memex_injection_hint` schema). Implementation is gated on grok-research's bundle
draft landing + flotilla-dev's review trio; this is the input to that.
**Issue:** [#18](https://github.com/jim80net/memex-hermes/issues/18)
**Author:** memex flotilla XO · **Date:** 2026-06-29
**Coordinating with:** flotilla-dev (owns the bundle post-grok), grok-research
(current bundle designer), hydra-ops.

## 1. The goal (operator headline)

A desk switched between harnesses (Claude Code ↔ Grok ↔ Codex ↔ OpenClaude)
keeps its operating context: the operator's **code-style preferences** and
**workflow constraints** travel with it. The constraints already live in the
shared memex corpus and every adapter reads them through the same memex-core
parser (#4 proved byte-compat; #6 made `memex_remember` actually propagate). This
design is the **takeover handshake**: flotilla writes a `HarnessContinuityBundle`
at switch time; memex consumes it at takeover and surfaces the right corpus
context into the new harness.

## 2. Authoritative contract (read from flotilla, not assumed)

flotilla's own `docs/harness-subscription-switching.md` §3.2 defines the bundle
(verified this session). The load-bearing fields for memex:

```jsonc
{
  "bundle_version": 1,
  "agent": "research",
  "project_root": "/home/operator/work/project",
  "from": { "surface": "claude-code", ... },
  "to":   { "surface": "grok", ... },
  "switch_token": "20260629T031400.000000001-a3f91b2c",
  "handoff_path": "/.../.flotilla/handoffs/switch-….md",   // the portable chapter snapshot
  "workspace_state_path": "/home/jim/.flotilla/research/state.md",
  "memex_injection_hint": "takeover-cross-harness"          // ← today a BARE STRING
}
```

Contract rules (from the doc): `handoff_path` is durability-gated identical to
recycle; **"memex MAY inject retrieved memories into the TO harness via that
harness's native channel … flotilla only passes the hint + paths"**; the bundle
is immutable once `last-switch.json` records `phase: "complete"`.

Two facts this resolves, and one it leaves open:
- **RESOLVED — per-harness handoff path is a non-issue for memex.** The handoff
  location is driver-owned and NOT uniform (claude → `.claude/handoffs/`,
  `claude.go:127`; grok → `.flotilla/handoffs/`, `grok.go:264`). But the bundle
  carries `handoff_path` explicitly, so memex reads it from the bundle — it never
  guesses the per-harness convention. Good.
- **RESOLVED — ownership split is exactly as proposed.** flotilla passes the hint
  + paths; memex does retrieval + injection via the harness's native channel
  (for memex-hermes: the `Hermes.system-prompt` block + a prefetch at init). The
  corpus content stays shared; neither side re-authors the constraints.
- **OPEN (contract question #1 for grok/flotilla-dev) — where is the BUNDLE
  itself?** The doc specifies the handoff path and the workspace-state path, but
  not the bundle's OWN on-disk location. memex needs a deterministic,
  harness-neutral path to read at init. **Proposal:** write the bundle next to the
  handoff at `<project_root>/.flotilla/switch/continuity-<switch_token>.json` (the
  product-owned `.flotilla/` home, harness-agnostic, durability-gated like the
  handoff). memex reads the newest such bundle at takeover.

## 3. The `memex_injection_hint` strawman (the red-line deliverable)

Today the hint is a bare string `"takeover-cross-harness"` — a mode label with no
steering. That is enough for a v1 "surface the chapter context" behavior, but it
gives the operator / flotilla no way to steer WHAT corpus context is surfaced.

**Proposal: keep the string as the v1 shorthand AND accept an optional structured
form, back-compatibly.** A consumer treats a bare string as `{mode: <string>}`.

```jsonc
"memex_injection_hint": {
  "hint_version": 1,
  "mode": "takeover-cross-harness",        // the existing label; the discriminator
  "queries": [                              // OPTIONAL — prefetch seeds INTO the corpus
    "operator code-style and review-workflow standards"
  ],
  "pin_entries": ["four-cs-standard"],      // OPTIONAL — explicit corpus entry names to always surface
  "types": ["rule", "memory"],              // OPTIONAL — corpus types to prioritize (constraints = rules)
  "scope": "project"                         // OPTIONAL — corpus scope (default: derive from project_root)
}
```

Design stance (minimal coupling): **the hint is a POINTER/QUERY into the corpus,
never the constraint text** (flotilla-dev agreed). Every field is optional; with
none, memex derives a query from the handoff markdown (the chapter snapshot) +
the `project_root` scope. flotilla/the operator add `queries`/`pin_entries` only
when they want to steer. This keeps flotilla's write side trivial (it may keep
emitting the bare string) while giving memex a richer contract to grow into.

## 4. memex consumption algorithm (memex-hermes; analogous per adapter)

At **`Hermes.init`** (the takeover hook — it already pulls the sync repo):

1. **Locate the bundle.** Read the newest `.flotilla/switch/continuity-*.json`
   under `project_root`/cwd whose `switch_token` has not been consumed this
   process. Absent / unparseable → **fallback** (step 6). Malformed JSON or a
   `bundle_version` memex doesn't support → fallback + a warn (never throw — a
   bundle problem must not break session start).
2. **Resolve scope** from `memex_injection_hint.scope` else `project_root` (map to
   the corpus project id the same way `resolveHermesProjectId` does).
3. **Pin entries.** For each `pin_entries` name, resolve it from the corpus index
   (by exact name, like `memex_recall`) and stage it for injection.
4. **Prefetch.** Run the corpus prefetch with `queries` (or, if none, a query
   derived from the handoff markdown's salient lines), filtered by `types`,
   honoring the normal prefetch budget/threshold.
5. **Surface via the native channel.** Append a **continuity block** to the
   `Hermes.system-prompt` output for this session: a short header + the pinned
   entries + the top prefetch results (bodies trimmed to the injected-chars
   budget). This is memex-hermes's "native channel"; memex-claude/grok/codex/
   openclaude each append to their own (grok system context, opencode
   instructions, …) — the RETRIEVAL is shared, the CHANNEL is per-adapter.
6. **Fallback (no/!bundle):** behave exactly as today — the static tool-inventory
   system-prompt block + per-prompt prefetch. Zero regression for a normal launch
   (which is the common case; a switch is the exception).

**Idempotency / consume-once.** Surface the continuity block once per switch.
Track the consumed `switch_token` (in the cache dir, e.g. `last-consumed-switch`)
so a re-init within the same session (or a crash-restart) does not re-inject. This
also prevents a stale bundle from a prior switch re-surfacing on an unrelated
launch.

**Harness-neutrality.** The bundle is JSON; the hint references corpus
entries/queries; every adapter resolves them through the same memex-core index →
identical retrieval. Only the injection CHANNEL differs per adapter (by design,
contract rule 2). No harness-specific assumption leaks into memex's read path.

## 5. Open contract questions (carry into BOTH trios)

1. **Bundle location** (§2) — where does flotilla write the bundle itself?
   Proposal: `<project_root>/.flotilla/switch/continuity-<switch_token>.json`.
2. **Hint richness** (§3) — accept the optional structured form, or keep the bare
   string for v1 and defer steering? (memex supports both; flotilla chooses how
   much to emit.)
3. **Handoff-as-query** — is it acceptable for memex to derive a prefetch query
   from the handoff markdown when `queries` is absent, or should the hint always
   carry an explicit query? (Affects how much the operator must steer.)
4. **Durability/timing** — flotilla-dev confirmed write-then-takeover; memex's
   fallback covers write-lag + the no-bundle launch. Confirm the bundle is
   durability-gated like the handoff (contract rule 1 implies yes for the
   handoff; extend to the bundle).
5. **Consume-once token store** — memex owns it (cache dir); flotilla need not
   track memex consumption. Confirm flotilla doesn't expect an ack.

## 6. Out of scope
- The flotilla WRITE side (grok-research's lane; this is the consumption + the
  hint red-line).
- A new corpus `type` for "constraint" — `type: rule` already carries workflow
  constraints; no schema change needed (the audit in #18 will confirm the
  operator's standards are authored as corpus rules, not adapter-local config).
- The other adapters' injection channels (memex-claude/grok/codex/openclaude
  implement step 5 in their own repos; this design is the memex-hermes instance +
  the shared contract).

## 7. Verification plan (when implementation is unblocked, post-grok-bundle)
- Unit: bundle parse (valid / malformed / unsupported version → fallback);
  hint string vs structured form; consume-once token; pin/prefetch surfacing;
  no-bundle fallback = byte-identical to today's system-prompt.
- e2e (MEMEX_E2E): a fixture bundle + a seeded corpus → init surfaces the pinned
  + prefetched entries in the continuity block; a second init does not re-inject.
- Cross-desk: a round-trip dry-run with flotilla-dev once the bundle writer exists.
