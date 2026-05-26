# Verification spike — what to run

This directory contains the pre-implementation verification spike that gates §3-§8 of the openspec change.

## Quick start

```bash
# 1. Pick a scratch HERMES_HOME (do NOT use your real ~/.hermes)
export HERMES_HOME=/tmp/hermes-spike
mkdir -p "$HERMES_HOME/plugins/memex-trace"

# 2. Drop in the trace provider
cp spike/trace_provider.py "$HERMES_HOME/plugins/memex-trace/__init__.py"
cat > "$HERMES_HOME/plugins/memex-trace/plugin.yaml" <<YAML
name: memex-trace
version: 0.0.0-spike
description: Verification spike — traces MemoryProvider callbacks
provides_memory_providers: [memex-trace]
YAML

# 3. Run Hermes against the scratch HERMES_HOME
hermes plugins enable memex-trace
hermes

# 4. In the Hermes session, exercise each scenario:
#    a) A plain turn:        "hello"
#    b) Built-in remember:   "remember that I prefer dark mode"
#    c) Read it back:        "what do you know about my preferences?"
#    d) End the session:     /exit  (or whatever the Hermes equivalent is)
#    e) (Optional) trigger compression if Hermes lets you

# 5. Inspect the log
cat "$HERMES_HOME/cache/memex-trace.log"
```

## What to record in SPIKE-COMPLETE.md

After running, commit `spike/SPIKE-COMPLETE.md` answering:

1. **Did `on_memory_write` fire when the built-in `remember` tool ran?** (yes/no)
2. **What was `action`, `target`, `content` set to for that call?**
3. **Did `initialize(**kwargs)` receive `hermes_home`, `cwd`, or any other useful kwargs?**
4. **Was `system_prompt_block()` called once or multiple times per session?**
5. **Does `sync_turn(user, assistant)` receive raw strings, message dicts, or something else?**
6. **Did any other unexpected callback fire?**
7. **Confirm `save_config(values, hermes_home)` receives `hermes_home` as a real argument** (rather than defaulting to `~/.hermes/`).

If the answer to (1) is **no**, the primary mirror path becomes the mtime-watcher inside `Hermes.sync-turn`. If yes, `on_memory_write` is primary. Both code paths ship regardless (G19 from the systems-review).

## Maintenance

Re-run this spike on every Hermes minor/major upgrade. Commit the log as `spike/<hermes-version>-trace.log` and update §8.4 of the design doc if behavior changed.
