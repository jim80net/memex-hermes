---
name: deep-sleep
description: "Extract learnings from past Hermes session transcripts and create appropriately-typed skills. Processes unreviewed sessions to find user preferences, recurring patterns, and troublesome workflows."
queries:
  - "learn from past sessions"
  - "extract patterns from conversation history"
  - "create memories from session transcripts"
  - "what did I learn in past sessions"
  - "analyze session history for patterns"
---

# /deep-sleep — Extract Learnings from Hermes Session Transcripts

Analyze past Hermes session transcripts to extract user preferences, recurring patterns, and troublesome workflows, then create appropriately-typed skills for future semantic injection.

## When to Use

- Daily to consolidate learnings from recent sessions
- After a productive session where many patterns were established
- When you notice the same corrections being made repeatedly

## Process

Perform the following steps directly. No external scripts or API keys needed.

`$HERMES_HOME` defaults to `~/.hermes` but is configurable; resolve it from the environment before running any path expression below:

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
```

### 1. Locate transcripts

Hermes' canonical message store is `state.db` (SQLite, under `$HERMES_HOME/state.db`) — that is the source of truth for messages. Per-session JSON snapshots at `$HERMES_HOME/sessions/session_<sid>.json` are written **only if** `sessions.write_json_snapshots` is true in `$HERMES_HOME/config.yaml` (default false; see `run_agent.py:_save_session_log`).

Prefer the JSON snapshots when they are present — they are easier to parse and avoid touching the live DB. Fall back to `state.db` otherwise.

```bash
# Preferred: per-session JSON snapshots (opt-in via sessions.write_json_snapshots)
ls $HERMES_HOME/sessions/session_*.json 2>/dev/null

# Fallback: query state.db directly (read-only)
# The exact table/column names vary by Hermes version; inspect the schema first:
sqlite3 -readonly "$HERMES_HOME/state.db" ".tables"
sqlite3 -readonly "$HERMES_HOME/state.db" ".schema"
```

<!-- TODO confirm Hermes session storage path: as of v0.14.0 (2026-05-26) the JSON
     snapshots live at $HERMES_HOME/sessions/session_{sid}.json and are opt-in;
     state.db is canonical. Re-confirm on Hermes minor/major upgrades. -->

Each JSON snapshot has the shape:

```json
{
  "session_id": "...",
  "model": "...",
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
```

Check the watermark file to find unprocessed sessions:

```bash
cat $HERMES_HOME/cache/memex/deep-sleep-watermark 2>/dev/null
```

If the watermark exists, only process snapshots modified after that timestamp. If no watermark exists, process files from the last 7 days. The user may also specify `--since YYYY-MM-DD`.

### 2. Extract user messages

From each transcript, extract entries where `role` is `"user"`. The `content` may be a string or an array of `{type, text}` objects (multimodal turns). Collect messages longer than 10 characters.

If pulling from `state.db`, run a read-only SELECT against the messages table; do not write or lock. Restrict the query by `created_at >= <watermark>` (or whatever the version's timestamp column is named) and group by `session_id`.

### 3. Analyze for learnings

Review the collected user messages and identify reusable patterns. Look for:

- **Preferences**: "always use X", "prefer Y over Z", "don't use W"
- **Recurring corrections**: User repeatedly fixing the same kind of mistake
- **Workflow patterns**: Multi-step processes the user follows
- **Tool usage tips**: Guidance about how to use specific tools (Bash, Edit, etc.)
- **Stop rules**: Patterns in assistant responses that should trigger continuation

Skip one-off requests. Only extract clear, reusable patterns.

### 4. Diagnose match quality (ASI extraction)

Scan each processed transcript for memex injection markers — lines containing `"The following was automatically loaded based on semantic relevance"` (the marker memex injects via `Hermes.prefetch` output that Hermes prepends to the model turn).

For each injection found:
1. Identify which skill/memory/rule was injected (from the section headings that follow the marker)
2. Classify the outcome:
   - **used**: The assistant clearly used the injected knowledge in its response
   - **ignored**: The injected knowledge was not referenced or acted upon
   - **corrected**: The user corrected the assistant's response in a way that contradicts the injected knowledge
3. Write a one-sentence diagnosis explaining why the match was helpful or unhelpful

Also scan for **missed matches** — cases where the user provided information that an existing skill already contains, but that skill was not injected. For missed matches, use `score: 0` and `queryIndex: -1`.

Record each observation to telemetry:

```bash
cat $HERMES_HOME/cache/memex/memex-telemetry.json
```

For each observation, add it to the entry's `observations` array in the telemetry file. The observation format:

```json
{
  "sessionId": "<session-id>",
  "prompt": "<the user prompt that triggered the injection>",
  "score": <similarity score or 0 for missed>,
  "queryIndex": <index of the matching query or -1 for missed>,
  "outcome": "used|ignored|corrected|missed",
  "diagnosis": "<one-sentence explanation>",
  "timestamp": "<ISO timestamp>"
}
```

Cap observations at 100 per entry (keep newest).

### 5. Deduplicate against existing knowledge

For each candidate learning, use memex's own semantic search to check for overlapping entries. Pipe the learning text as a `Hermes.prefetch` query:

```bash
echo '{"hook_event_name":"Hermes.prefetch","args":{"query":"<candidate learning text>"},"session_id":"deep-sleep-dedup","cwd":"'"$(pwd)"'"}' \
  | "$HERMES_HOME/cache/memex/bin/memex"
```

If the output contains `additionalContext` with a match at relevance >= 80%, the learning is already covered. Read the matched entry to confirm — if the existing entry says the same thing, skip the candidate. If the existing entry is related but incomplete, update it instead of creating a duplicate.

This uses the same embedding-based similarity that memex uses at runtime, so dedup quality matches injection quality.

### 6. Classify and create entries

For each novel learning, determine the right type based on how critical and universal it is:

| Pattern observed | Type | Destination |
|-----------------|------|-------------|
| Corrected 3+ times across sessions | `rule` | `<cwd>/.hermes/skills/<name>/SKILL.md` with `type: rule` |
| Preference or fact stated once | `memory` | `<cwd>/.hermes/skills/<name>/SKILL.md` with `type: memory` |
| Multi-step procedure | `skill` | `<cwd>/.hermes/skills/<name>/SKILL.md` with `type: skill` |
| Ordered multi-step process | `workflow` | `<cwd>/.hermes/skills/<name>/SKILL.md` with `type: workflow` |
| Tool-specific guidance | `tool-guidance` | `<cwd>/.hermes/skills/<name>/SKILL.md` |
| Stop condition pattern | `stop-rule` | `<cwd>/.hermes/skills/<name>/SKILL.md` |

Note: memex-hermes stores rules as skills with `type: rule` in the frontmatter — there is no separate `rules/` directory (see project spec C5). Hermes' Skills UI/CLI surfaces everything under `skills/` uniformly; memex differentiates by frontmatter.

**For entries classified as rules** (corrections made 3+ times), create a SKILL.md with full frontmatter and `type: rule`:

```yaml
---
name: <kebab-case-name>
description: "<one sentence: what this rule prevents>"
type: rule
queries:
  - "<query 1>"
  - "<query 2>"
  - "<query 3>"
one-liner: "<short reminder version>"
---
<the full rule explanation>
```

**For all other types**, create a SKILL.md:

```yaml
---
name: <kebab-case-name>
description: "<one sentence: when is this useful>"
type: <memory|skill|workflow|tool-guidance|stop-rule>
queries:
  - "<natural query 1>"
  - "<natural query 2>"
  - "<natural query 3>"
  - "<natural query 4>"
  - "<natural query 5>"
---
<the actual instruction or knowledge, 1-5 lines>
```

### 7. Update watermark

Write the current ISO timestamp to the watermark file:

```bash
mkdir -p $HERMES_HOME/cache/memex
date -u +%Y-%m-%dT%H:%M:%SZ > $HERMES_HOME/cache/memex/deep-sleep-watermark
```

### 8. Report results

Summarize what was created:
- Number of transcripts processed (and which source: JSON snapshots vs. state.db)
- Learnings found (by type)
- Rules created (for repeatedly-corrected patterns)
- Skills created (for other learnings)
- Duplicates skipped

## Options

The user may specify:
- `--dry-run`: Show extracted learnings without creating files
- `--since <date>`: Process transcripts from this date (ISO format)
- `--global-scope`: Write skills to `$HERMES_HOME/skills/` instead of `<cwd>/.hermes/skills/`
- `--from-db`: Force reading from `state.db` even if JSON snapshots are present

$ARGUMENTS
