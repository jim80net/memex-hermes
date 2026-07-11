# memex-hermes addendum — G3 shared-origin projection (skills + rules-as-skills)

**Date:** 2026-07-11  
**Status:** design only — **no implementation in this PR**  
**Authority:** G3 adapter alignment brief (`memex-flotilla/briefs/adapter-alignment-g3-2026-07-11.md`); product steer `flotilla-dispatch-c29001c1`  
**Pin (impl):** `@jim80net/memex-core@^0.6.0` (npm LIVE; hermes currently pins `^0.5.0` — bump at impl)  
**Proven path:** memex-grok#30 design + #31 impl (`src/core/projection.ts`)  
**Parent design:** [`2026-05-25-memex-hermes-adapter-design.md`](./2026-05-25-memex-hermes-adapter-design.md) (C5 rules-in-skills, C6 hermes sync checkout, C7 MEMORY.md, C11 single envelope dispatch)  
**Core peer:** memex-core `design/shared-origin-sync-profile.md` + `src/origin.ts` (`resolveOriginRoot` / `planProjection` / `applyProjection`)  
**Scope:** memex-hermes only. Author ≠ merger; surface PRs to **memex** for gate/merge.

---

## 0. Bottom line

Hermes does **not** get a `$HERMES_HOME/rules/` tree. Verified invariant **C5** / openspec `hermes-path-resolution`: rules live under **`$HERMES_HOME/skills/<name>/SKILL.md`** with frontmatter `type: rule`. G3 alignment therefore projects the **shared origin `skills/` tree as skill-dir symlinks** into the real Hermes harness skills paths, using **only** core `resolveOriginRoot` → `planProjection` / `applyProjection` (absolute symlinks; fail-closed; never clobber). Memory delivery stays the existing Hermes surface (provider + prefetch tools + MEMORY.md mirror) — **not** a Grok-style inject-first redesign.

**Impl gate:** this design passes memex systems-review → pin `memex-core@^0.6.0` → thin `projection.ts` + entrypoints + scan policy + doctor/health messaging → verify plan (no freelancing).

---

## 1. Problem today (verified in tree)

| Gap | Code / evidence |
|-----|-----------------|
| Core pin pre-origin | `package.json` → `"@jim80net/memex-core": "^0.5.0"` (lock resolves `0.5.0`); npm has `0.6.0` with origin APIs |
| No projection layer | No `src/core/projection.ts`; no calls to `planProjection` / `applyProjection` / `resolveOriginRoot` |
| Sync is **scan-of-checkout**, not harness projection | `assembleHermesScanDirs` (`src/core/scan-roots.ts:37-44`): when `config.sync.enabled`, appends `getSyncScanDirs(paths.syncRepoDir).skillsDir` (`<syncRepo>/skills`) into `skillDirs` — does **not** write links under `$HERMES_HOME/skills` |
| Default checkout is adapter-local (C6) | `getHermesPaths` → `syncRepoDir: ~/.local/share/memex-hermes` (`hermes-paths.ts:173-175`); local-path `sync.repo` can override via `applySyncRepoOverride` |
| Harness skills paths exist; not origin-managed | User: `$HERMES_HOME/skills` (`hermes-paths.ts:78`); project: `<cwd>/.hermes/skills` only when `HERMES_ENABLE_PROJECT_PLUGINS` truthy (`:154-167`) |
| No separate rules dir by design | `HermesPaths.globalRulesDir` **aliases** `skillsDir` (`:98-99`); config documents no `ruleDirs` (`config.ts:47-48`); scan always sets `ruleDirs: []` (`scan-roots.ts:35`) |
| Health is reachability-only | `handleHealth` (`hooks/health.ts`): enabled + embeddingModel; optional `access(syncRepoDir)` warn — no origin/projection provenance |
| Doctor is a skill checklist | `skills/doctor/SKILL.md` — provider dir, config key, binary, cache, scan paths — no shared-origin / symlink checks |
| Binary is envelope-only | `src/main.ts` stdin JSON → `Hermes.*` switch (C11); no `init`/`sync` CLI subcommands like memex-grok |

Operator product direction for G3: same lifecycle model as Grok-first, **harness-specific paths filled from this tree**.

---

## 2. Goals and non-goals

### Goals (Hermes adapter slice)

| ID | Goal |
|----|------|
| **H1** | Pin `@jim80net/memex-core@^0.6.0` and call **only** core origin/projection primitives (no reimplemented symlink policy). |
| **H2** | When projection profile is **set**: ensure harness skills dirs and **symlink** origin skill entries so `readlink` shows origin. |
| **H3** | Fail-closed no-clobber: real files/dirs / foreign symlinks → conflict report; never overwrite. |
| **H4** | Scan policy: **one content blob → one index entry** (no double-scan origin checkout + projected harness). |
| **H5** | Doctor/health messaging: origin present; projected entries are links into origin; conflict WARN; no inject-first messaging regression for Hermes' legitimate prefetch surface. |
| **H6** | Idiomatic entrypoints: session `Hermes.init` (auto, idempotent) + optional explicit operator path for dogfood without inventing a parallel CLI brand. |

### Non-goals (this wave)

- Inventing `$HERMES_HOME/rules/` or scanning a foreign `rules/` harness dir (violates C5 / path-resolution spec).
- Re-projecting origin flat `rules/*.md` **files** into Hermes as if they were SKILL.md trees (different on-disk shape; other adapters own that layout). Hermes rules that belong in the shared corpus must already be (or be materialized as) **origin `skills/<name>/SKILL.md`** with optional `type: rule`.
- Inject-first redesign; #20 constitution dump; refinement product; codex-memex-dev cutover.
- Forking a Hermes-only origin layout or migrating all hosts off C6 checkout in this PR (resolver + optional local-path unify is enough for v1).
- Skills **write-path** rewrite (`memex_remember` / session-end commit-push continue to use `paths.syncRepoDir` until a deliberate unify follow-on).

---

## 3. Verified harness map (do not invent paths)

All paths derived from `src/core/hermes-paths.ts`, `scan-roots.ts`, `config.ts`, openspec `hermes-path-resolution`.

| Role | Path | Notes |
|------|------|--------|
| Hermes home | `resolveHermesHome()` → arg / `MEMEX_HERMES_HOME` / `~/.hermes` | Never hardcode in callers |
| **User skills (rules live here)** | `$HERMES_HOME/skills` | `skillsDir` = `globalSkillsDir` = `globalRulesDir` |
| Project skills | `<cwd>/.hermes/skills` | Only when `HERMES_ENABLE_PROJECT_PLUGINS` ∈ `{1,true,yes,on}` |
| Extra skill roots | `config.skillDirs` + Hermes `config.yaml` `external_dirs` | Unmanaged by projection |
| Config | `$HERMES_HOME/memex.json` | `loadConfig` |
| Hermes activation config | `$HERMES_HOME/config.yaml` | `memory.provider: memex` |
| Built-in always-on memory files | `$HERMES_HOME/memories/{MEMORY,USER}.md` | C7 mirror; **not** projection targets |
| Cache / index | `$HERMES_HOME/cache/memex/…` | Unchanged |
| Historical sync checkout (C6) | default `~/.local/share/memex-hermes` | `paths.syncRepoDir`; local-path `sync.repo` override via `applySyncRepoOverride` |
| Shared origin (product) | core `resolveOriginRoot` → prefer `~/.memex`, then XDG / legacy-claude | **Projection root**; not invented here |

### Projection targets (v1)

Use core `entryKind: "skill-dirs"` (whole child dir with `SKILL.md` linked — matches `listSkillDirEntries` in core `origin.ts`).

```ts
// Conceptual — impl post-gate only
const targets: ProjectionTarget[] = [
  {
    id: "hermes-user-skills",
    targetDir: paths.skillsDir,           // $HERMES_HOME/skills
    originRelDir: "skills",
    entryKind: "skill-dirs",
    initTargetDir: true,
  },
];
// Project-scoped ONLY when:
//   projectPluginsEnabled() && explicit projectOriginRelDir
// (same anti-double-link discipline as grok v1 — do not link origin skills/
//  into both user and project dirs.)
if (projectPluginsEnabled() && opts.projectOriginRelDir) {
  targets.push({
    id: "hermes-project-skills",
    targetDir: getProjectSkillsDir(cwd),  // <cwd>/.hermes/skills
    originRelDir: opts.projectOriginRelDir, // e.g. projects/<id>/skills
    entryKind: "skill-dirs",
    initTargetDir: true,
  });
}
```

**Explicitly out of v1 targets:**

| Tempting path | Why not |
|---------------|---------|
| `$HERMES_HOME/rules` | Forbidden by C5 / path-resolution spec; `globalRulesDir` is already the skills dir |
| Origin `rules/` as `entryKind: "files"` into skills | Would drop bare `*.md` files into a dir Hermes expects as skill **directories**; breaks Skills UI/CLI and skill-dirs indexing |
| `$HERMES_HOME/memories/*` | C7 always-on memory; not shared-origin projection |
| `config.skillDirs` / `external_dirs` | Operator-owned; never clobber or manage |

---

## 4. Core API mapping (consume, do not reimplement)

| Core API (`@jim80net/memex-core@^0.6.0`) | Hermes use |
|------------------------------------------|------------|
| `resolveOriginRoot({ root?, homeDir?, env? })` | Resolve projection origin; optional explicit root from config |
| `defaultOriginRoot(home)` | Documented product default (`~/.memex`); do not hardcode forever |
| `planProjection(originRoot, targets, { relinkManaged: true })` | Plan links + conflicts |
| `applyProjection(plan, { onClobber: "fail-closed" })` | Partial apply; never clobber |
| `initSyncRepo` / `syncPull` | Existing session init + optional pre-project pull against **checkout path** (see §5 coexistence) |
| `SyncProfile` types | Bridge from `HermesConfig.sync` for clarity; thin adapter helper ok |

**Hermes must not:** invent `~/.memex-hermes-origin`, copy origin trees into skills without links, or reimplement classify/relink/clobber policy in the adapter.

---

## 5. Profile “set” signal + origin / C6 coexistence

### 5.1 Profile set (v1)

Same decisive arm as Grok:

```text
isProjectionProfileSet(config) ⇔ config.sync.enabled === true
```

Evidence today: `DEFAULT_CONFIG.sync.enabled` is **false** (`config.ts:64-65`); enable via `$HERMES_HOME/memex.json`.

When profile is **not** set: no projection automation; keep current scan behavior; doctor/health advisory only.

Optional future knobs (core `SyncProfile` / adapter extension — **not required for v1**): explicit `projectSkills: false` kill-switch. Default when `sync.enabled`: skills projection **on**.

### 5.2 Explicit origin root

Grok maps `config.sync.repoDir` → `resolveOriginRoot({ root })`. Hermes **today has no `repoDir` field** — only `sync.repo` (URL or local path) and `paths.syncRepoDir`.

**v1 recommendation (minimal schema change):**

1. **`resolveOriginRoot({ root: hermesOriginOverride(config, paths) })`** where override is, in order:
   - optional new thin field `sync.repoDir` / `sync.originRoot` **if** added at impl for parity with Grok (preferred name: follow Grok `repoDir` once pinned types allow), else
   - when `sync.repo` is a **local filesystem path** (existing `isLocalPath` heuristic in `hermes-paths.ts`), use the expanded path as explicit root,
   - else `undefined` → core walks `~/.memex` → XDG → legacy-claude → default `~/.memex`.
2. Do **not** silently treat remote git URLs as origin roots.

### 5.3 Coexistence with copy-scan sync (C6)

Two paths exist today and must not double-serve the same content:

| Mode | `sync.enabled` | Projection | Scan skills |
|------|----------------|------------|-------------|
| A — legacy scan | true | off / not yet run | harness skills **+** `getSyncScanDirs(syncRepoDir).skillsDir` (today) |
| B — projected (G3 target) | true | active | harness skills **only** for corpus (links resolve into origin); **do not** also append raw origin/checkout `skills/` |
| C — local only | false | off | harness + skillDirs + external_dirs only |

**Write/push path (v1 unchanged):** `Hermes.init` / `commitAndMaybePush` / memory mirror continue to use `paths.syncRepoDir` (C6 default or local-path override). Unifying write checkout onto product `~/.memex` is a **follow-on** (operator can already point `sync.repo` at a local origin path to collapse them).

**Invariant:** one content blob → one index entry. When `rulesProjectionActive` / `skillsProjectionActive` (profile set), `assembleHermesScanDirs` **skips** the `getSyncScanDirs(...).skillsDir` append.

---

## 6. Entrypoints (idiomatic to Hermes)

Hermes is not a multi-subcommand MCP binary like memex-grok. Prefer existing surfaces.

### 6.1 Primary — `Hermes.init` (session start)

Today (`hooks/init.ts`): registry + optional `initSyncRepo` + `syncPull` when `sync.enabled && sync.repo`.

**Post-gate:** after successful pull (or when profile set even for local-only origin), call the same projection helper as Grok's `runGrokProjection` (Hermes-named). Idempotent; fail-closed conflicts logged via `logger.warn` with conflict paths; never throw away the rest of init (`{ ok: true }` unless broader init policy changes).

### 6.2 Secondary — explicit operator / dogfood

Either (pick at impl; both acceptable if docs match):

1. **`python -m memex_hermes.project`** (or `…init_projection`) — mirrors `python -m memex_hermes.install`; sets env, invokes binary or shared TS helper; flags `--strict`, `--dry-run`, `--json`, `--hermes-home`.
2. **Envelope event** `Hermes.project` (or reuse a dry-run path) driven by the doctor skill / scripts — keeps C11 “one dispatch surface” if implementation stays inside the binary.

**Do not** add a second event brand for every doctor check; doctor skill runs shell/`python -m` and inspects `readlink`.

### 6.3 Not in scope as primary

- New ambient inject path.
- Replacing `prefetch` with “memory = tools only” messaging (Hermes prefetch inject is the designed primary memory surface — see §8).

---

## 7. Fail-closed no-clobber (inherit core)

Core policy (locked in 0.6.0):

- Target missing → create absolute symlink into origin.
- Target already correct managed link → noop (or relink if `relinkManaged` and origin moved).
- Target real file / real dir / foreign symlink / type mismatch → **conflict**, leave untouched.
- `applyProjection` is partial-success: non-conflicts apply; conflicts reported.

Hermes wrapper prints/logs summary: `linked` / `skipped` / `conflicts`. `--strict` (explicit CLI) exits non-zero on any conflict; session init logs WARN and continues (session must not die because of one local skill name collision).

---

## 8. Memory surface (keep Hermes; no inject-first regression)

| Surface | Stance for G3 |
|---------|----------------|
| `Hermes.prefetch` / tools `memex_search|remember|recall` | **Keep** — primary semantic + agent-driven memory for this harness |
| Hermes built-in MEMORY.md / USER.md + mirror | **Keep** (C7); not projection targets |
| Grok-style “memory = MCP tools only, hooks dormant” | **Do not copy** into Hermes doctor copy — that wording is Grok-specific (D1/D3) |
| New inject-first ambient path | **Non-goal** |
| #20 audience dump into shareable origin | **Non-goal** |

Doctor messaging must say: *shared skills/rules-as-skills project as symlinks into `$HERMES_HOME/skills`; session memory remains provider + tools + MEMORY.md* — not “disable inject.”

---

## 9. Doctor / health messaging

### 9.1 `skills/doctor/SKILL.md` (primary UX)

Add steps after existing binary/cache checks:

| Check | When | Severity | Intent |
|-------|------|----------|--------|
| `shared-origin` | always | OK if resolved origin exists; WARN if profile set and missing; note `source` (explicit/env/default/xdg/legacy-claude) | Origin present / not initialized |
| `skills-projection` | profile set | OK if managed skill dirs under `$HERMES_HOME/skills` are symlinks into origin; WARN if never projected (“run project entrypoint”); WARN listing **real-path conflicts** | Links + no clobber |
| `scan-no-double-index` | profile set | Document / script check that index scan policy skips raw origin skills when projected | One blob → one entry |
| `memory-surface` | always | OK describing **Hermes** surfaces (provider active, tools, MEMORY.md) — **not** Grok MCP-only copy | No inject-first regression |

### 9.2 `Hermes.health` (optional thin enrichment)

Keep cheap. Optional fields or `reason` suffixes when profile set: origin exists? last projection conflict count unknown is fine — full projection audit stays in doctor. Do not download models or walk entire skills trees on every health probe.

---

## 10. Implementation sketch (post-gate only)

Ordered; **do not start until this design is gated**.

1. **Pin** `@jim80net/memex-core@^0.6.0`; update lockfile; fix any type fallout.
2. **`src/core/projection.ts`** — thin adapter: `isProjectionProfileSet`, `buildHermesProjectionTargets`, `resolveHermesOrigin`, `runHermesProjection`, `skillsProjectionActive` (mirrors grok `projection.ts`).
3. **`assembleHermesScanDirs`** — when `skillsProjectionActive(config)`, skip `getSyncScanDirs(...).skillsDir` append; unit tests for double-index absence.
4. **Wire `handleInit`** — after pull, `runHermesProjection` (non-fatal conflicts).
5. **Explicit entrypoint** — `python -m memex_hermes.project` and/or envelope; `--strict` / `--dry-run`.
6. **Doctor skill** steps + tests where automatable; health only if free.
7. **Docs** — USAGE.md projection section; pointer from parent design C5/C6.
8. **Verify** §11; no dogfood desk required if manual verify documented.

---

## 11. Verify / dogfood plan

No dedicated live Hermes fleet desk is assumed. Manual verify is the bar unless memex assigns a host.

### 11.1 Preconditions

- Design gated by memex.
- Impl PR pin `memex-core@^0.6.0`.
- `$HERMES_HOME/memex.json` with `sync.enabled: true`.
- Origin resolvable (product `~/.memex` or explicit local path) with at least one `skills/<name>/SKILL.md` (optionally `type: rule`).

### 11.2 Procedure

1. Baseline: provider install + `memory.provider: memex`; `Hermes.health` ready.
2. Place dogfood skill under origin: `skills/dogfood-hermes/SKILL.md`.
3. Run projection entrypoint (`python -m …` or start session to hit `Hermes.init`).
4. Prove provenance:
   ```bash
   ls -la "${HERMES_HOME:-$HOME/.hermes}/skills"
   readlink -f "${HERMES_HOME:-$HOME/.hermes}/skills/dogfood-hermes"  # → under origin
   ```
5. Conflict drill: real directory at managed name → re-run must not clobber; doctor WARN lists conflict.
6. Index: search/prefetch finds dogfood content **once** (no duplicate hits from checkout + harness).
7. Regression suite: `pnpm test` / `pytest test/python` / existing e2e if `MEMEX_E2E=1`.
8. Confirm MEMORY.md mirror + tools still function (no memory-surface regression).

### 11.3 Success criteria

- [ ] Design gated by memex.
- [ ] Impl: pin 0.6.0 + projection + scan policy + doctor steps.
- [ ] `readlink` → origin for managed skill dirs.
- [ ] No `$HERMES_HOME/rules/` created.
- [ ] No double-index when projected.
- [ ] No new inject-first path; prefetch/tools/MEMORY.md intact.

---

## 12. Test plan (acceptance)

| Layer | Coverage |
|-------|----------|
| Unit | skill-dir symlink create / idempotent re-run / real-dir conflict / foreign symlink conflict |
| Unit | `assembleHermesScanDirs` omits origin skills when projection active; includes when legacy-only |
| Unit | profile-off → projection no-op message |
| Unit | paths: never emits `…/rules` as a managed harness dir |
| Integration | existing dispatch / tool / mirror tests stay green |
| Manual | §11 |

---

## 13. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Operators expect Grok-style `~/.hermes/rules` | C5 + this design + doctor text: rules are skills with `type: rule` |
| Double-index via C6 checkout + projected skills | §5.3 scan policy |
| Clobber local skills | core fail-closed; init non-fatal WARN |
| Origin `rules/*.md` invisible on Hermes | Documented: Hermes indexes skill-dirs only; convert/materialize to `skills/<name>/SKILL.md` in origin if cross-harness rule needed |
| C6 checkout vs `~/.memex` split brain | resolveOriginRoot for projection; optional local-path unify; write-path follow-on |
| Windows symlink privileges | inherit core absolute-symlink v1; Linux dogfood first |
| Session init latency | projection is FS-only; no embedding; conflicts skip |

---

## 14. Relationship to parent decisions

| Decision | This chapter |
|----------|--------------|
| **C5** rules in skills | Reinforced — projection targets **skills only** |
| **C6** `~/.local/share/memex-hermes` | Write/push checkout default retained; projection origin via core resolver |
| **C7** MEMORY.md | Unchanged; not projected |
| **C11** envelope dispatch | Projection helper called from `Hermes.init`; optional thin Python module for dogfood — no parallel engine mode flag |
| **C12** `_session/*` no remote push | Unchanged |
| Cross-adapter byte identity | Origin layout owned by core; hermes does not invent parallel trees |

---

## 15. Coordination / backlog settle markers

### ## Backlog

| Marker | Item | Owner |
|--------|------|-------|
| `[blocked] settle: design-gate` | Impl blocked until this design is gated by **memex**. | memex |
| `[blocked] settle: impl-after-design-gate` | No projection code / core pin bump until gate. | memex-hermes |
| `[follow-on] settle: write-path-origin-unify` | Optionally make write/push checkout default to product origin (`defaultOriginRoot`) without stranding existing C6 checkouts. | memex-hermes |
| `[follow-on] settle: project-skills-origin-rel` | When three-tier SCOPE is common, pass `projects/<id>/skills` as `projectOriginRelDir` under project-plugins gate. | memex-hermes + core |
| `[non-goal] settle: hermes-rules-dir` | Never create `$HERMES_HOME/rules/`. | — |
| `[non-goal] settle: inject-first` | No inject-first redesign; keep Hermes prefetch/tools/MEMORY.md. | — |
| `[non-goal] settle: issue-20-dump` | #20 constitution audience still awaiting-auth — do not dump into shareable origin. | operator |

---

## 16. References (read for this draft)

- G3 brief: `~/workspace/memex-flotilla/briefs/adapter-alignment-g3-2026-07-11.md`
- Chapter brief: `briefs/file-rules-shared-origin-2026-07-10.md`
- Grok design: memex-grok `docs/superpowers/specs/2026-07-10-file-rules-symlink-init.md` (#30)
- Grok impl: `src/core/projection.ts` (#31)
- Core: `src/origin.ts`, `src/types.ts` (`ProjectionTarget`, `SyncProfile`), `getSyncScanDirs` in `src/sync.ts`
- Hermes code: `src/core/hermes-paths.ts`, `config.ts`, `scan-roots.ts`, `hooks/init.ts`, `hooks/health.ts`, `skills/doctor/SKILL.md`
- Specs: `openspec/specs/hermes-path-resolution/spec.md` (rules-in-skills)
- Parent: `docs/specs/2026-05-25-memex-hermes-adapter-design.md` (C5–C12)
