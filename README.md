# memex-hermes

Semantic skill, memory, and rule router for [Hermes Agent](https://hermes-agent.nousresearch.com/) (NousResearch). Plugs Hermes into the same `memex` corpus that powers [`memex-claude`](https://github.com/jim80net/memex-claude) and [`memex-openclaw`](https://github.com/jim80net/memex-openclaw) — so a fact remembered in one harness reaches the others via git sync.

Built on [`@jim80net/memex-core`](https://github.com/jim80net/memex-core), the shared engine for embedding, indexing, and searching knowledge artifacts.

> **Status:** alpha — this repository was bootstrapped on 2026-05-25. The pre-implementation verification spike (see `openspec/changes/bootstrap-memex-hermes-adapter/tasks.md` §2) must complete before the provider can ship.

## Why this exists

AI coding assistants are paint-by-number systems: a canvas (the model) and a coloring-book outline (the system prompt). Every directive you add — guidelines, rules, project notes — adds more lines to the page. As your knowledge accumulates, every session starts with all of it loaded, whether relevant or not. Attention degrades.

The solution is **gradual disclosure**: start with universal principles, then bring in additional directives at the point of consumption when the conversation actually turns toward those tasks. When you need to trade a ticker, the relevant know-how appears. When you're deploying, the deployment checklist surfaces. When you're just writing code, nothing extra clutters the context.

`memex-hermes` makes this work for Hermes. Skills, memories, and rules are embedded for semantic retrieval; the right ones surface at the right moment. And because the on-disk format is identical to the other memex adapters, knowledge syncs both ways across Claude Code, OpenClaw, and Hermes — without re-authoring.

## How it works

```
User turn ──► Hermes.prefetch (per-turn) ─┐
                                          │
                                          ▼
                            Python MemoryProvider (off-loop)
                                          │
                                          ▼
                            subprocess: `memex` binary  ← same artifact memex-claude ships
                                          │
                                          ▼
                            embed query → cosine-search index
                                          │
                                          ▼
                            return formatted context to Hermes
                                          │
                                          ▼
                            Hermes prepends it to the next LLM call
```

A separate write path mirrors Hermes' built-in `MEMORY.md` / `USER.md` edits into the shared sync repo, so they reach other harnesses on the next pull.

| Provider method | What memex does |
|---|---|
| `prefetch(query)` | Per-turn semantic match → markdown to inject |
| `sync_turn(user, assistant)` | Append turn to trace; record telemetry; mtime-watch `MEMORY.md` |
| `on_memory_write(action, target, content)` | Mirror Hermes' write into the sync repo + commit |
| `on_session_end(messages)` | Extract learnings → write `session-learning` entries |
| `system_prompt_block()` | Static block describing memex tools + sync state |
| `handle_tool_call(name, args)` | Dispatch `memex_search` / `memex_remember` / `memex_recall` |

## Prerequisites

- [Hermes Agent](https://hermes-agent.nousresearch.com/) (Python ≥ 3.10)
- Disk write access to `$HERMES_HOME` (default `~/.hermes/`)
- Optional: a git remote for cross-platform sync

No API keys required — embeddings run locally via ONNX.

## Installation

### Option A: PyPI (recommended once published)

```bash
pip install memex-hermes
hermes plugins enable memex
```

The bundled `bin/memex` wrapper downloads the right prebuilt binary for your platform on first run, SHA256-verified.

### Option B: Manual clone (for developers)

```bash
git clone https://github.com/jim80net/memex-hermes "$HERMES_HOME/plugins/memex"
"$HERMES_HOME/plugins/memex/bin/install.sh"
hermes plugins enable memex
```

### Option C: From source (contributors)

```bash
git clone https://github.com/jim80net/memex-hermes
cd memex-hermes
pip install -e ".[dev]"
pnpm install     # for the TypeScript engine side
```

## Configuration

Optionally create `$HERMES_HOME/memex.json` to customize behavior:

```json
{
  "enabled": true,
  "prefetch": { "topK": 3, "threshold": 0.5 },
  "sync": {
    "enabled": true,
    "repo": "git@github.com:you/your-memex-sync.git"
  }
}
```

Full reference forthcoming in [USAGE.md](USAGE.md). For now see the design doc at [`docs/specs/2026-05-25-memex-hermes-adapter-design.md`](docs/specs/2026-05-25-memex-hermes-adapter-design.md).

## Cross-platform sync

Set the same `sync.repo` git URL on `memex-hermes`, `memex-claude`, and `memex-openclaw` and they share a corpus: skills authored in one harness appear in the others; memories written in one appear in the others; learnings extracted in one appear in the others. Project-ID canonicalization, on-disk format, and embedding cache layout are byte-identical across adapters by design.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Notable: this repo has **two source trees** — a Python plugin (`memex_hermes/`) and a TypeScript engine extension (`src/`). The Python layer is intentionally thin; engine logic stays in `@jim80net/memex-core`. See the [design doc](docs/specs/2026-05-25-memex-hermes-adapter-design.md) for the architectural rationale.

## License

MIT
