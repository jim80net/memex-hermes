"""End-to-end integration tests for memex-hermes (tasks §11).

The whole suite is gated on the ``MEMEX_E2E=1`` environment variable
(see ``conftest.py``). When unset every test in this directory is
skipped with a clear reason so CI pipelines and contributors can
safely run ``pytest`` without spinning up the Hermes runtime.

The tests in this directory exercise the provider end-to-end against
the real ``memex-hermes`` binary on disk (``$HERMES_HOME/cache/memex/
bin/memex`` by default, or overridden by ``MEMEX_HERMES_BINARY``).
They do NOT mock the runner, the subprocess, or the filesystem; the
goal is to catch contract drift between the Python layer, the
binary, and the on-disk sync repo format.

See ``README.md`` in this directory for the local runbook.
"""
