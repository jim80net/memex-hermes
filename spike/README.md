# Verification spike — what to run

This directory gates §3-§8 of the openspec change.

> **Status (2026-05-26): RESOLVED FROM SOURCE.** On a host with an editable Hermes
> install, the `MemoryProvider` contract was verified directly against
> `agent/memory_provider.py`, `agent/memory_manager.py`, `plugins/memory/__init__.py`,
> and `agent/agent_init.py`. Findings (with file:line citations and the R1–R7 divergence
> inventory) are in **`spike/SPIKE-COMPLETE.md`**. The runtime run below is now an
> **optional confirmation**, not a discovery step.

## Registration — how Hermes actually loads a memory provider

Memory providers are **NOT** loaded via the generic `hermes_agent.plugins` entry-point or
`hermes plugins enable`. The generic PluginManager explicitly skips `memory/`
(`hermes_cli/plugins.py:819-829`) and has no `register_memory_provider`
(`:1073-1078`). Instead, `plugins/memory/__init__.py` **scans two directories** — bundled
`plugins/memory/<name>/` and user `$HERMES_HOME/plugins/<name>/` — and the active provider
is selected by the **`memory.provider` config key** (`agent_init.py:999-1005`). Only **one**
external provider may be active at a time.

## Optional runtime confirmation

```bash
# 1. SCRATCH HERMES_HOME (do NOT use your real ~/.hermes — only one provider may be active)
export HERMES_HOME=/tmp/hermes-spike
mkdir -p "$HERMES_HOME/plugins/memex-trace"

# 2. Drop in the (corrected) trace provider as the plugin's __init__.py
cp spike/trace_provider.py "$HERMES_HOME/plugins/memex-trace/__init__.py"

# 3. Select it via config (NOT `hermes plugins enable`)
printf 'memory:\n  provider: memex-trace\n' >> "$HERMES_HOME/config.yaml"

# 4. Run Hermes against the scratch HERMES_HOME
hermes

# 5. In the Hermes session, exercise each scenario:
#    a) A plain turn:        "hello"
#    b) Built-in remember:   "remember that I prefer dark mode"
#    c) Read it back:        "what do you know about my preferences?"
#    d) End the session:     /exit  (or whatever the Hermes equivalent is)
#    e) (Optional) trigger compression if Hermes lets you

# 6. Inspect the log
cat "$HERMES_HOME/cache/memex-trace.log"
```

## What the run confirms (the contract is already in SPIKE-COMPLETE.md)

A live run adds belt-and-suspenders confirmation of three items source cannot fully settle:

1. The exact `metadata` dict keys on a real built-in `remember` write (`on_memory_write`'s
   4th arg — see R3). Source confirms the call **fires** (`tool_executor.py:642`).
2. `system_prompt_block()` invocation count across a session incl. resume/compression.
3. Which optional hooks fire in a vanilla CLI session (expect `on_turn_start`, `sync_turn`,
   `initialize`, `system_prompt_block`, `shutdown`; `on_session_switch` only on
   `/resume|/branch|/reset|/new`/compression).

`on_memory_write` is the **primary** mirror path (confirmed to fire); the `Hermes.sync-turn`
mtime-watcher is the secondary safety net. Both ship regardless (G19).

## Maintenance

Re-run on every Hermes minor/major upgrade. Re-diff the ABC source against R1–R7 in
`SPIKE-COMPLETE.md` and update §8.4 of the design doc if the contract changed.
