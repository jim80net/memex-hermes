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
none, memex uses the `mode`'s built-in default query (NOT the whole handoff
markdown — a multi-KB blob makes a smeared embedding that retrieves nothing) +
the `project_root` scope.

**Trim per the trio (avoid coupling against zero demand):** ship `mode` +
optional `queries` + optional `pin_entries` (the two with a real use today —
"seed the prefetch" and "always surface the standing constraints") + `hint_version`
(the one cheap insurance field, with an explicit degrade: unknown `hint_version`
→ treat as bare-string/mode-only, parallel to the `bundle_version` rule). **Defer
`types`/`scope`** until a concrete steering customer exists — flotilla's write
side shouldn't have to populate them across four drivers with no demand. flotilla
may keep emitting the bare string forever; memex coerces `string → {mode}` as the
first step of consumption.

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
1. **Locate the bundle.** Read `.flotilla/switch/continuity-*.json` under cwd,
   selecting by `switch_token` (lexical = chronological — NOT mtime), the newest
   unconsumed one **whose `agent`/`project_root` binds to THIS desk** (open
   contract Q — §5). All bundle I/O is wrapped in `try/catch → logger.warn →
   fall through` (the `init.ts:46-48` discipline); absent / malformed JSON /
   unsupported `bundle_version` → no staging (never throw).
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

**Harness-neutrality.** The bundle is JSON; the hint references corpus
entries/queries; every adapter resolves them through the same memex-core index →
identical retrieval. Only the injection CHANNEL differs per adapter (by design,
contract rule 2). No harness-specific assumption leaks into memex's read path.

## 5. Open contract questions (carry into BOTH trios)

0. **PREREQUISITE — corpus ingest of the standing constraints (#20).** The
   constraints aren't in the shared corpus yet (§0). This is upstream of the
   whole contract; flag it as the gating dependency, not a memex-internal detail.
1. **Bundle location** (§2) — where does flotilla write the bundle itself?
   Proposal: `<project_root>/.flotilla/switch/continuity-<switch_token>.json`.
1b. **Bundle ↔ desk binding** — how does the consumer know a bundle is for THIS
   desk (not a sibling switch in a shared `project_root`)? memex-hermes doesn't
   obviously know its flotilla `agent` name. Candidate: match `project_root`==cwd
   AND the `to.surface` equals this adapter; or flotilla writes to a desk-scoped
   path. Real contract gap — resolve with flotilla-dev/grok.
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
