# Subagent threads

bb hides Claude Code's native `Agent`/`Task` tools (`provider-claude-code`
setting `subagentsDisabled`), so hooks or instructions that say "run the X
agent" leave the model with no way to do it. This headless plugin adds an
instruction block to **Claude Code threads in bb only**: run each subagent
(e.g. `~/.claude/agents/<name>.md`) as a child bb thread in the same
workspace (`bb thread spawn --parent-self`), wait for it, and read its output.

Nothing changes outside bb or for other providers. Instructions apply when a
thread's Claude session is next constructed (new thread or restart).

No settings, no storage.
