---
name: doctor
description: "Diagnose and fix memex-hermes installation, setup, or runtime problems. Run checks on the provider directory, config key, binary, ONNX libs, cache, model, and scan paths."
queries:
  - "memex is not working"
  - "hermes memory provider is not loading"
  - "no skills are being injected"
  - "troubleshoot memex"
  - "diagnose memex problems"
  - "memex setup issues"
  - "fix memex-hermes installation"
  - "why is memex silent"
  - "memory.provider memex not active"
---

# /doctor — Diagnose memex-hermes Issues

Run through a Hermes-tailored diagnostic checklist to identify why memex isn't being activated as Hermes' memory provider, or why it is loaded but not surfacing matches. Execute each step in order and stop at the first failure found.

`$HERMES_HOME` defaults to `~/.hermes` but is configurable; resolve it from the environment before running any path expression below:

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
```

## Diagnostic Steps

### 1. Provider directory present and well-formed

Verified Hermes v0.14.0 contract (per `spike/SPIKE-COMPLETE.md` R1): memory providers are discovered by a directory scan of `$HERMES_HOME/plugins/<name>/`, and the `__init__.py` must contain the literal substring `MemoryProvider` or `register_memory_provider` within its first 8192 bytes. The pip entry-point alone does NOT register a memory provider.

```bash
# Directory exists
ls -la "$HERMES_HOME/plugins/memex/"

# __init__.py is present and discovery-recognizable
test -f "$HERMES_HOME/plugins/memex/__init__.py" && head -c 8192 "$HERMES_HOME/plugins/memex/__init__.py" | grep -qE 'MemoryProvider|register_memory_provider' \
  && echo "OK: discovery marker present" \
  || echo "FAIL: directory or discovery marker missing"
```

**Fixes:**
- Directory missing -> run `python -m memex_hermes.install` (materializes the provider dir from the installed wheel), or clone the repo into `$HERMES_HOME/plugins/memex/`.
- Marker missing -> reinstall; do not hand-edit `__init__.py`.

### 2. memory.provider config key

Activation is gated on the `memory.provider` config key in `$HERMES_HOME/config.yaml` (verified per `agent_init.py:999-1005`). NOT `hermes plugins enable`.

```bash
grep -A2 '^memory:' "$HERMES_HOME/config.yaml"
```

You should see:

```yaml
memory:
  provider: memex
```

Note: the `MemoryManager` accepts the built-in provider plus exactly ONE external provider (`agent/memory_manager.py:265-280`, per `SPIKE-COMPLETE.md` R2). If another external provider (honcho, mem0, hindsight, retaindb, supermemory, etc.) is set as `memory.provider`, memex will not be active. The single-provider constraint is enforced by Hermes, not by memex.

**Fixes:**
- Wrong / missing key -> edit `$HERMES_HOME/config.yaml` and set `memory.provider: memex`.
- Another external provider set -> decide which one you want; only one external provider may be active.

### 3. Binary present and runnable

The bundled `bin/memex` wrapper downloads the prebuilt binary on first run and installs it under `$HERMES_HOME/cache/memex/bin/memex` (verified — `hermes-plugin-packaging` spec). Subsequent invocations exec it directly.

```bash
# Binary location after first-run install
ls -la "$HERMES_HOME/cache/memex/bin/memex"

# ONNX shared libraries alongside the binary
ls -la "$HERMES_HOME/cache/memex/bin/"libonnxruntime* 2>/dev/null   # Linux/macOS
ls -la "$HERMES_HOME/cache/memex/bin/"onnxruntime.dll 2>/dev/null    # Windows

# Smoke test: minimal Hermes.health envelope through the binary
echo '{"hook_event_name":"Hermes.health","args":{},"session_id":"diag","cwd":"/tmp"}' \
  | "$HERMES_HOME/cache/memex/bin/memex"
```

Expected: a JSON object on stdout (shape per `src/core/envelope.ts` `HermesHealthOutput`).

**Fixes:**
- No binary -> run the install wrapper: `"$HERMES_HOME/plugins/memex/bin/memex" health < /dev/null` (the wrapper downloads on first run and SHA256-verifies).
- ONNX libs missing -> re-run the installer; do not just copy the binary alone.
- Crashes with shared-lib error -> verify your platform matches the downloaded artifact; check `~/.hermes/cache/memex/checksums.txt`.

### 4. memex config (memex.json)

memex's own settings live in `$HERMES_HOME/memex.json` — separate from Hermes' `config.yaml`. It is optional; absent file means defaults.

```bash
cat "$HERMES_HOME/memex.json" 2>/dev/null || echo "No memex.json (using defaults)"
```

Verify:
- `enabled` is not `false`
- `prefetch.threshold` isn't set so high that nothing matches (default 0.5)
- JSON is valid (no trailing commas, etc.)

Test config loading via a real prefetch envelope:

```bash
echo '{"hook_event_name":"Hermes.prefetch","args":{"query":"test"},"session_id":"diag","cwd":"/tmp"}' \
  | "$HERMES_HOME/cache/memex/bin/memex" 2>&1
```

If stderr shows `memex: invalid JSON` or config errors, fix `$HERMES_HOME/memex.json`.

### 5. Scan paths

Verify skills, memories, and rules exist where memex looks. Rules in memex-hermes are skills with `type: rule` in the frontmatter; there is no separate `rules/` directory (project spec C5).

```bash
# Global skills (memex-hermes-managed)
ls "$HERMES_HOME/skills/"*/SKILL.md 2>/dev/null

# Project-local skills (from current cwd)
ls "$(pwd)/.hermes/skills/"*/SKILL.md 2>/dev/null

# Hermes built-in memories (auto-injected by Hermes, also indexed by memex)
ls "$HERMES_HOME/memories/"{MEMORY,USER}.md 2>/dev/null

# memex per-project memory (back-of-context)
ls "$HERMES_HOME/cache/memex/projects/"*/memory/*.md 2>/dev/null
```

If no files are found in any location, memex has nothing to inject. Create a test skill:

```bash
mkdir -p "$HERMES_HOME/skills/test-skill"
cat > "$HERMES_HOME/skills/test-skill/SKILL.md" << 'EOF'
---
name: test-skill
description: "Test skill to verify memex works"
type: memory
queries:
  - "is memex working"
  - "test memex"
---
If you can see this, memex-hermes is working correctly.
EOF
```

Then test by typing "is memex working" in your next Hermes turn.

### 6. Embedding model cache and skill index

```bash
# Model cache location (downloaded on first run, ~23MB)
ls "$HERMES_HOME/cache/memex/models/" 2>/dev/null

# Skill index cache
ls "$HERMES_HOME/cache/memex/memex-cache.json" 2>/dev/null

# Memory-mtime tracker (for the on_memory_write secondary mirror path)
ls "$HERMES_HOME/cache/memex/memory-mtimes.json" 2>/dev/null
```

If the model cache is empty, the first run will download the ONNX model. This requires internet access. If behind a proxy or firewall, the model download may fail silently.

To force a cache rebuild, delete the skill index cache:

```bash
rm "$HERMES_HOME/cache/memex/memex-cache.json" 2>/dev/null
```

### 7. End-to-end with verbose output

Run memex manually and inspect stderr for diagnostics:

```bash
echo '{"hook_event_name":"Hermes.prefetch","args":{"query":"install dependencies"},"session_id":"diag-test","cwd":"'"$(pwd)"'"}' \
  | "$HERMES_HOME/cache/memex/bin/memex" 2>/tmp/memex-debug.log
cat /tmp/memex-debug.log
```

Stderr messages prefixed with `memex:` indicate specific failures:
- `invalid JSON input` — stdin isn't valid JSON
- `index build failed` — problem scanning or embedding skills
- `handler error` — runtime error in the hook handler

If `Hermes.prefetch` returns context but nothing surfaces in a real Hermes session, the provider is registered but not selected. Re-check step 2 (`memory.provider: memex`) and confirm only one external provider is configured.

## Common Issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Provider absent from `hermes` startup | Directory missing at `$HERMES_HOME/plugins/memex/` | `python -m memex_hermes.install` |
| Provider visible to `hermes plugins list` but not activating | `memory.provider` not set to `memex` | Edit `$HERMES_HOME/config.yaml` (step 2) |
| Provider visible but a different external provider wins | `MemoryManager` allows only ONE external provider | Choose which one; only one external can be active |
| `{}` on every prompt | No skills/memories found | Create content in scan paths (step 5) |
| `{}` on every prompt | Threshold too high | Lower `prefetch.threshold` in `$HERMES_HOME/memex.json` |
| Binary crashes | Missing ONNX shared library | Re-run the binary wrapper (downloads + ONNX libs together) |
| Slow first run | Model downloading | Wait for download (~23MB), ensure internet access |
| Stale results | Cache not rebuilding | Delete `$HERMES_HOME/cache/memex/memex-cache.json` |
| MEMORY.md edits not mirroring | `Hermes.memory-write` AND `Hermes.sync-turn` mtime-watcher both should be running | Verify by editing MEMORY.md directly and checking the next turn; `remove` actions arrive only via the mtime-watcher (per `SPIKE-COMPLETE.md` Q1) |
| Sync not pushing | `_session/*` project ID (no real cwd) | Use `memex_remember` with `scope: 'project'` to promote; or run Hermes from inside a real project dir |

$ARGUMENTS
