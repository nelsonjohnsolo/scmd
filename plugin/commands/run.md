---
description: Launch SCMD memory review in the background
disable-model-invocation: true
allowed-tools: Bash(npx -y --prefix="${CLAUDE_PLUGIN_ROOT}" --prefer-online @nelsonjohnsolo/scmd@latest)
---
Launch SCMD exactly once for this Claude Code session.

1. If an SCMD background task from this command is already running, do not start another or duplicate it. Report its previously captured URL instead.
2. Invoke the Bash tool with exactly these inputs:
   - command: `npx -y --prefix="${CLAUDE_PLUGIN_ROOT}" --prefer-online @nelsonjohnsolo/scmd@latest`
   - run_in_background: true
   The plugin root prefix isolates package resolution from the current project. `@latest` and `--prefer-online` select the current published release with a fresh registry check. Use the Bash tool's background execution. Do not add shell `&` or use `nohup`.
3. Follow the background task output. Wait until stdout contains a complete line beginning `SCMD running at `.
4. Report the complete loopback URL after that prefix verbatim, including its `127.0.0.1` port, path, and `token` query value. Do not shorten or redact it.
5. If the task exits, fails, or reports an error before `SCMD running at ` appears, report the launcher failure promptly with the available stdout and stderr. Do not claim SCMD is running and do not retry automatically.
