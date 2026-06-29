# Design — memex consumption of the HarnessContinuityBundle (issue #18)

**Status:** strawman for cross-desk red-line (memex consumption half + a proposed
`memex_injection_hint` schema). Implementation is gated on grok-research's bundle
draft landing + flotilla-dev's review trio; this is the input to that.
**Issue:** [#18](https://github.com/jim80net/memex-hermes/issues/18)
**Author:** memex flotilla XO · **Date:** 2026-06-29
**Coordinating with:** flotilla-dev (owns the bundle post-grok), grok-research
(current bundle designer), hydra-ops.

## 0. GATING PREREQUISITE (the review-trio crux — read first)

The cross-harness review trio surfaced, and this session verified, that **the
operator's standing code-style/workflow constraints are NOT in the shared
cross-adapter corpus** (issue **#20**): they live in `~/.claude/rules/*.md`
inside `dot_claude.git` (claude-adapter-local dotfiles), while the memex sync
corpus every adapter pulls is `claude-skill-router-corpus`. So a memex-grok desk
pulls a corpus that does **not** contain those constraints — the bundle below
would point at an empty shelf for exactly what #18 promises to preserve.

**This design (bundle consumption) is sound but DOWNSTREAM of #20.** The real
critical path is: (1) ingest the standing constraints into the shared corpus
(#20 — operator decision on the canonical authoring/sync path), THEN (2) this
consumption design surfaces them at takeover. Both are needed; #20 is the
prerequisite. The hint-contract red-line below is still worth converging with
flotilla-dev in parallel.

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

flotilla's own `docs/harness-subscription-switching.md` **§3.3 (resolution) +
§3.4 (schema)** define the bundle (re-synced to the canonical write-side
2026-06-29; supersedes the earlier §3.2 draft this doc first cited). The
load-bearing fields for memex:

```jsonc
// <project_root>/.flotilla/switch/<flotilla_agent>/continuity-<switch_token>.json
{
  "bundle_version": 1,
  "flotilla_agent": "grok-research",   // REQUIRED — desk binding (namespaced; not "agent")
  "project_root": "/home/operator/work/project",
  "from": { "surface": "claude-code", ... },
  "to":   { "surface": "grok", ... },
  "switch_token": "20260629T031400.000000001-a3f91b2c",
  "handoff_path": "/.../.flotilla/handoffs/switch-….md",   // the portable chapter snapshot
  "workspace_state_path": "/home/operator/.flotilla/grok-research/state.md",
  "hint_version": 1,                    // TOP-LEVEL (read before parsing the hint)
  "memex_injection_hint": "takeover-cross-harness"          // bare STRING (or optional {mode,queries[],pin_entries[]})
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
  (for memex-hermes: the `Hermes.prefetch` `additionalContext` — see §4). The
  corpus content stays shared; neither side re-authors the constraints.
- **RESOLVED (flotilla §3.3/§3.4, verified 2026-06-29) — bundle location +
  desk-binding.** flotilla writes the bundle **desk-scoped** at
  `<project_root>/.flotilla/switch/<flotilla_agent>/continuity-<switch_token>.json`
  (durability-gated like the handoff). memex resolves it without scanning, in
  this order:
  1. **`$FLOTILLA_SELF`** (provisioned in the smart-desk launch env per
     `docs/inter-harness.md:90-91`) → read exactly ONE file at
     `…/switch/$FLOTILLA_SELF/continuity-<token>.json`.
  2. **`bundle_path`** recorded in `~/.flotilla/<flotilla_agent>/last-switch.json`
     → the explicit pointer (robust; no filename-format dependency).
  3. **Content-match fallback** (adapters without `$FLOTILLA_SELF`): accept a
     bundle only when `project_root == cwd` AND `to.surface == this adapter`.
  The **desk-scoped path segment resolves the old desk-binding question (Q1b) by
  construction** — sibling desks sharing a worktree do not collide. The bundle
  also carries a required top-level `flotilla_agent` field to validate
  path↔content binding.

NOTE (field names, per §3.4): the desk identity field is **`flotilla_agent`**
(namespaced to avoid colliding with a harness's own "agent"); **`hint_version`**
is a **top-level** sibling of `memex_injection_hint` (so memex reads the version
BEFORE deciding how to parse the hint, and it survives the bare-string form).

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
none, memex uses the `mode`'s built-in default query (NOT the whole handoff
markdown — a multi-KB blob makes a smeared embedding that retrieves nothing) +
the `project_root` scope.

**Trim per the trio (avoid coupling against zero demand):** ship `mode` +
optional `queries` + optional `pin_entries` (the two with a real use today —
"seed the prefetch" and "always surface the standing constraints"). **Defer
`types`/`scope`** until a concrete steering customer exists. `hint_version` lives
at the **bundle TOP LEVEL** (sibling of `memex_injection_hint`, per §3.4), read
BEFORE parsing the hint, with the agreed degrade: unknown `hint_version` →
mode-only interpretation (parallel to `bundle_version`). flotilla may emit the
bare string forever; memex coerces `string → {mode}` as the first step of
consumption.

## 4. memex consumption algorithm (memex-hermes; analogous per adapter)

**Corrected per the review trio (P0): the injection surface is `Hermes.prefetch`,
NOT `Hermes.system-prompt`.** Verified: `system-prompt` takes `Record<string,
never>` (`envelope.ts:227`) — zero inputs, no cwd/session/bundle, and a cached
byte-static block (D5); it cannot see a switch. `Hermes.init` carries cwd +
sessionId but returns `{ok:true}` (`envelope.ts:145`) — no model-visible output.
`Hermes.prefetch` is the ONLY model-visible, session/cwd-bearing, dynamic surface
(it returns `additionalContext`, `prefetch.ts:112-120`, and already honors
`maxInjectedChars`). So the split is **init = detect + stage; prefetch = inject.**

**Also corrected (P1): takeover-only injection ≠ "keeps its context".** Standing
constraints must RECUR through the session, not greet once. memex-core already
has the right mechanism — rules surface with a full body once then a one-liner
reminder per session. So the bundle should **prime the standing-constraint set
into the per-prompt prefetch path**, not dump a one-shot block. Two channels:
a **standing channel** (pinned constraints, surfaced every prompt via the rule
loop) and a **topical channel** (a one-shot rehydration from the handoff).

**At `Hermes.init` (detect + stage):**
1. **Locate the bundle** (desk-scoped resolution, §2 / flotilla §3.3 — no
   glob/scan): (a) if `$FLOTILLA_SELF` is set, read exactly one file at
   `<project_root>/.flotilla/switch/$FLOTILLA_SELF/continuity-<token>.json`;
   else (b) resolve the explicit `bundle_path` from
   `~/.flotilla/<flotilla_agent>/last-switch.json`; else (c) content-match
   fallback (`project_root == cwd` AND `to.surface == this adapter`). Validate
   the bundle's top-level `flotilla_agent` matches the path segment. All bundle
   I/O is wrapped in `try/catch → logger.warn → fall through` (the
   `init.ts:46-48` discipline); absent / malformed JSON / unsupported top-level
   `bundle_version` → no staging (never throw).
2. **Validate + bound (trust gate).** `handoff_path` / `project_root` MUST stay
   within the project boundary; cap the total injected size; the handoff-derived
   query (step 4) is untrusted text used for retrieval only.
3. **Resolve scope** from `memex_injection_hint.scope` else `project_root`
   (`resolveHermesProjectId`-style). **Pin entries:** resolve each `pin_entries`
   name from the corpus by exact name. **Stage** the pins + the resolved queries
   into a disk payload keyed by `session_id` + `switch_token`, under
   `withFileLock` (cross-process — every event is a fresh process; reuse the
   `init.ts:41-45` lock idiom; the same `savePrefetchInjections` disk-handoff
   pattern `prefetch.ts` already uses).

**At the first `Hermes.prefetch` of that session (inject, consume-once):**
4. Under `withFileLock`, read the staged payload for this `session_id`; if its
   `switch_token` is unconsumed, prepend a **continuity block** (pinned standing
   constraints + a bounded topical rehydration) to `additionalContext`, then
   record the consumed token. A bounded query (default: the hint `mode`'s
   built-in default query, or a capped salient-line extract from the handoff —
   never the whole markdown) seeds the topical retrieval.
5. **Recurrence:** the pinned standing constraints ride the normal rule-reminder
   loop for the rest of the session (full once, reminder after) — that is what
   makes the constraints *keep* applying, not just greet.

6. **Fallback (no/foreign/malformed bundle):** behave exactly as today — the
   static system-prompt block + normal per-prompt prefetch. Zero regression for a
   normal launch (the common case). Verified by a `malformed-bundle-PRESENT →
   output byte-identical to no-bundle` test (the real regression vector), not
   only the no-bundle case.

**Harness-neutrality.** The injection CHANNEL is per-adapter (memex-hermes:
`prefetch.additionalContext`; others: grok system context, opencode
instructions); the RETRIEVAL is shared (the memex-core index). Contract addition:
an adapter MUST have a model-visible dynamic-injection point to consume the
bundle; one without falls back to no-op (the bundle is advisory, never required).
The bundle is JSON and the hint references corpus entries/queries, so every
adapter resolves them through the same memex-core index → identical retrieval;
no harness-specific assumption leaks into memex's read path.

## 5. Contract questions (status after the cross-desk red-line)

0. **PREREQUISITE — corpus ingest of the standing constraints (#20).** The
   constraints aren't in the shared corpus yet (§0). Upstream of the whole
   contract; the gating dependency. **Still open — operator's call.**
1. ✅ **RESOLVED (§3.3/§3.4)** — Bundle location + desk-binding. Desk-scoped path
   `<project_root>/.flotilla/switch/<flotilla_agent>/continuity-<token>.json`,
   resolved via `$FLOTILLA_SELF` → else `bundle_path` in `last-switch.json` →
   else content-match (§2). The desk-scoped segment resolves binding by
   construction; field is `flotilla_agent`.
2. ✅ **RESOLVED** — Hint richness: flotilla emits the bare string + top-level
   `hint_version`; memex accepts the optional `{mode,queries[],pin_entries[]}`;
   `types`/`scope` deferred.
3. ✅ **RESOLVED (mitigated)** — Handoff-as-query footgun: memex never queries the
   whole handoff; the no-`queries` default is the `mode`'s built-in query (or a
   capped salient-line extract), bounded.
4. ✅ **RESOLVED** — Durability/timing: write-then-takeover confirmed; the bundle
   is durability-gated like the handoff (§3.4); memex's fallback covers
   write-lag + the no-bundle launch.
5. **Consume-once token store** — memex owns it (cache dir, `withFileLock`);
   flotilla need not track memex consumption. flotilla-dev confirmed no ack
   expected. (Closeable.)

## 6. Out of scope
- The flotilla WRITE side (grok-research's lane; this is the consumption + the
  hint red-line).
- A new corpus `type` for "constraint" — `type: rule` already carries workflow
  constraints; no schema change needed. (The #20 audit confirmed the operator's
  standards are NOT yet corpus rules — they're adapter-local dotfiles; that
  ingest is #20's job, not a new type.)
- The other adapters' injection channels (memex-claude/grok/codex/openclaude
  implement the inject step in their own repos; this design is the memex-hermes instance +
  the shared contract).

## 7. Verification plan (when implementation is unblocked, post-grok-bundle)
- Unit: bundle parse (valid / malformed / unsupported version → fallback);
  hint string vs structured form; consume-once token; pin/prefetch surfacing;
  no-bundle fallback = byte-identical to today's system-prompt.
- e2e (MEMEX_E2E): a fixture bundle + a seeded corpus → init surfaces the pinned
  + prefetched entries in the continuity block; a second init does not re-inject.
- Cross-desk: a round-trip dry-run with flotilla-dev once the bundle writer exists.
