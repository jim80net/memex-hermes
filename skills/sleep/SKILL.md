---
name: sleep
description: "Manage the sleep cycle: migrate MEMORY.md, CLAUDE.md, and rules into semantically-searchable skills, and promote/demote entries based on match telemetry."
queries:
  - "convert memories to skills"
  - "optimize memory for semantic search"
  - "migrate MEMORY.md to skill format"
  - "make memories searchable"
  - "reduce context window usage from memories"
  - "clean up CLAUDE.md"
  - "move rules to skills"
  - "promote memory to rule"
  - "demote rule to skill"
  - "sleep management"
---

# /sleep — Knowledge Lifecycle Management (Hermes)

Manage the bidirectional flow between front-of-context (always loaded: project README, `$HERMES_HOME/memories/MEMORY.md`, `$HERMES_HOME/memories/USER.md`) and back-of-context (semantically loaded: skills under `$HERMES_HOME/skills/`). Migrate growing content into skills, and promote/demote entries based on match telemetry.

Hermes auto-injects its built-in `MEMORY.md` / `USER.md` on every turn the same way Claude Code injects `CLAUDE.md`. Anything that lives there is "always-on" context — fine for universal preferences and project identity, expensive once it grows. Skills are semantically loaded by memex at the point of consumption.

## When to Use

- After accumulating many entries in `$HERMES_HOME/memories/MEMORY.md` via the built-in `remember` tool
- When project READMEs or `CLAUDE.md`-style files have grown with task-specific knowledge that doesn't belong in always-loaded context
- When rules (`SKILL.md` with `type: rule`) contain situational guidelines that should be semantically loaded instead
- To review match telemetry and promote/demote entries based on usage patterns
- Daily as knowledge hygiene

## Process

Perform the following steps directly with shell-level file edits. No external scripts or API keys needed.

`$HERMES_HOME` defaults to `~/.hermes` but is configurable; resolve it from the environment before running any path expression below:

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
```

### 1. Gather sources

Locate all knowledge sources for this project:

```bash
# Hermes built-in memories (front-of-context, auto-injected)
$HERMES_HOME/memories/MEMORY.md
$HERMES_HOME/memories/USER.md

# memex per-project memory (back-of-context, semantically loaded)
$HERMES_HOME/cache/memex/projects/<encoded-cwd>/memory/*.md

# Project-level instructions
<cwd>/CLAUDE.md
<cwd>/AGENTS.md
<cwd>/README.md sections that read as instructions, not docs

# Existing skills (back-of-context)
<cwd>/.hermes/skills/*/SKILL.md
$HERMES_HOME/skills/*/SKILL.md

# Match telemetry
$HERMES_HOME/cache/memex/memex-telemetry.json
```

Where `<encoded-cwd>` is the cwd with `/` replaced by `-` and `.` replaced by `-`.

Read all of these. The telemetry file contains per-entry match counts, session counts, and timestamps.

### 2. Audit built-in MEMORY.md / USER.md

`$HERMES_HOME/memories/MEMORY.md` and `USER.md` are injected by Hermes itself on every turn (see `agent/memory_manager.py` built-in provider). The longer they get, the more attention is spent on them whether relevant or not. Split each into sections and classify:

- **universal**: User identity, persistent preferences, account/email/contact facts that genuinely belong in every turn — keep in MEMORY.md / USER.md
- **task-specific**: Procedures, checklists, domain knowledge that only applies during certain tasks — migrate to skill
- **preference**: Short rules or preferences — migrate to memory-skill or consider as rule candidate

For task-specific sections, create a SKILL.md (see step 6). Remove the migrated section from MEMORY.md, leaving a one-line breadcrumb so a human maintainer can find where it went:

```markdown
<!-- Migrated to skill: deployment-checklist -->
```

Edit the file with your normal text-editing tools; the built-in `remember` tool's `action: "remove"` does not surface to external providers via `on_memory_write` (verified in `spike/SPIKE-COMPLETE.md` Q1) but is captured by the `Hermes.sync-turn` mtime-watcher on the next turn — both paths converge.

**Do not** remove the user-identity or persistent-preference sections. Those are universal and belong at the front of context.

### 3. Audit project instruction files (CLAUDE.md / AGENTS.md / README sections)

If the project keeps an in-repo instruction file (`CLAUDE.md`, `AGENTS.md`, an "Agent instructions" section of the README), apply the same audit. Universal project identity stays. Task-specific procedures migrate to skills. Short preferences migrate to memory-skills or rules.

### 4. Audit rules (skills with `type: rule`)

memex-hermes stores rules as skills with `type: rule` in the frontmatter, not in a separate `rules/` directory (see CLAUDE.md / project spec C5: rules ride in the skills dir). For each rule:

- If it **lacks frontmatter** (a `SKILL.md` body without a `---` block), add frontmatter with `name`, `description`, `queries`, `type: rule`, and `one-liner` fields. This enables memex to do graduated disclosure (full body on first match; one-liner on subsequent matches) instead of injecting the full content every time.

- If it is **situational** (only relevant during specific tasks, not a universal guardrail), drop `type: rule` and let it become a regular skill. memex will inject it semantically instead of treating it as a near-always-on rule.

Example frontmatter for a rule:

```yaml
---
name: no-force-push
description: "Never force-push to main or master branches"
type: rule
queries:
  - "git push"
  - "force push"
  - "push to main"
one-liner: "Never force-push to main/master."
---
```

### 5. Audit memex per-project memory

Read `$HERMES_HOME/cache/memex/projects/<encoded-cwd>/memory/*.md` and any topic files. Split into sections and classify:

- **memory**: Short preference, rule, or fact -> migrate to skill with `type: memory`
- **skill**: Procedural knowledge with steps -> migrate to skill with `type: skill`
- **workflow**: Multi-step ordered process -> migrate to skill with `type: workflow`
- **keep**: Structural reference, navigation link, or TOC entry -> stays in the memory file

### 6. Deduplicate against existing knowledge

Before creating new entries, check each candidate against the existing index using memex's semantic search via the binary:

```bash
echo '{"hook_event_name":"Hermes.prefetch","args":{"query":"<candidate section text>"},"session_id":"sleep-dedup","cwd":"'"$(pwd)"'"}' \
  | "$HERMES_HOME/cache/memex/bin/memex"
```

If the output contains `additionalContext` (or matching entries above relevance >= 80%), an existing entry already covers this knowledge. Read the matched entry to confirm. If it says the same thing, skip the candidate. If the existing entry is related but incomplete, update it instead of creating a duplicate.

### 7. Generate SKILL.md for each migratable section

For each section to migrate, create:

```
<cwd>/.hermes/skills/<kebab-case-name>/SKILL.md     # project-local
# or
$HERMES_HOME/skills/<kebab-case-name>/SKILL.md      # global (with --global-scope)
```

Format:

```yaml
---
name: <kebab-case-name>
description: "<one sentence describing when this knowledge is needed>"
type: <memory|skill|workflow|rule>
queries:
  - "<natural query 1>"
  - "<natural query 2>"
  - "<natural query 3>"
  - "<natural query 4>"
  - "<natural query 5>"
---
<original section body>
```

Generate 5 diverse, natural queries a developer would type when they need this knowledge.

### 8. Evolve queries for existing entries

Read the telemetry file (`$HERMES_HOME/cache/memex/memex-telemetry.json`) and examine `observations` and `queryHits` for each indexed entry.

**Classify each query** in an entry's `queries` list:
- **Strong** (>30% of total hits, good outcomes): Keep as-is
- **Weak** (<10% of hits): Candidate for replacement
- **Dead** (0 hits across all sessions): Candidate for replacement
- **Toxic** (drives false positives — high match count but mostly "ignored"/"corrected" outcomes): Replace

**Mutate weak/dead/toxic queries only** — never touch strong queries. For each replacement, ensure diversity across these styles:
- Formal: "How do I configure the deployment pipeline?"
- Casual: "deploy setup"
- Action-oriented: "set up CI/CD"
- Keyword-heavy: "deployment pipeline configuration YAML"
- Disambiguating: "deploy to production (not staging)"

**Optionally adjust boost**: If a skill is consistently matched just below the threshold (appears in observations with low scores but "used" outcomes), consider adding `boost: 0.05` to its frontmatter. If a skill consistently triggers false positives, consider `boost: -0.05`.

Present all proposed changes as a table before applying:

```
Entry                    Query #  Current Query              Action     New Query
---------------------------------------------------------------------------------
prefer-pnpm              q2       "node package manager"     Replace    "pnpm vs npm which to use"
deploy-checklist         q0       "deploy"                   Replace    "production deployment checklist steps"
deploy-checklist         q3       "release process"          Keep       (strong: 42% of hits)
api-key-location         boost    (none)                     Add        boost: 0.05
```

After user approval, update the SKILL.md frontmatter for each modified entry. Then clear processed observations from telemetry using the `observations` field deletion.

### 9. Review telemetry for promotion/demotion

Read `$HERMES_HOME/cache/memex/memex-telemetry.json`. For each indexed entry, review its telemetry:

| Signal | Recommendation |
|--------|---------------|
| Memory with high matchCount (>20) across many sessions (>10) | **Promote to rule** — this is important enough to surface near-always. Re-frontmatter the SKILL.md to `type: rule` and add a `one-liner`. |
| Rule with low matchCount (<3) or no matches in 30+ days | **Demote to skill** — this is situational, not universal. Change `type: rule` to `type: skill` (or memory/workflow as fits). |
| Multiple memories on the same topic | **Consolidate into skill** — merge related memories into a single, richer skill entry. |
| Skill that's rarely matched (<2 matches ever) | **Review for relevance** — queries may need updating, or the knowledge may be obsolete. Flag for user review. |

Present a table of recommended actions to the user:

```
Entry                    Type     Matches  Sessions  Last Matched  Recommendation
---------------------------------------------------------------------------------
prefer-pnpm              memory   45       22        2d ago        Promote to rule
deploy-checklist         rule     2        2         45d ago       Demote to skill
git-rebase-workflow      memory   0        0         never         Review/remove
api-key-location         memory   31       18        1d ago        Promote to rule
test-db-setup            memory   8        6         3d ago        OK (no action)
debug-tips-1             memory   12       8         5d ago        Consolidate with debug-tips-2
```

Execute promotions/demotions that the user approves.

### 10. Clean up source files

- Remove migrated sections from `$HERMES_HOME/memories/MEMORY.md` and `USER.md`. If empty, leave the file in place — Hermes' built-in provider expects them to exist.
- Remove migrated sections from project instruction files (leave breadcrumb comments).
- Delete individual memory-skills that were consolidated.

### 11. Verify

List the created/modified files and confirm everything looks correct:

```bash
ls -la <cwd>/.hermes/skills/*/SKILL.md
ls -la $HERMES_HOME/skills/*/SKILL.md
head -20 $HERMES_HOME/memories/MEMORY.md
```

The memex cache will auto-rebuild on the next `Hermes.prefetch` (mtime-based).

## Options

The user may specify:
- `--dry-run`: Show what would be created/moved/promoted without writing files
- `--global-scope`: Write skills to `$HERMES_HOME/skills/` instead of `<cwd>/.hermes/skills/`
- `--telemetry-only`: Skip migration, only show telemetry review and promotion/demotion recommendations
- `--no-telemetry`: Skip telemetry review, only do migration

$ARGUMENTS
