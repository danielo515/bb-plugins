# Background audits

Runs your Claude Code review gates in bb without blocking turns or filling the
conversation.

The gates are `~/.claude/hooks/effect-review-gate.sh` and
`~/.claude/hooks/naming-review-gate.sh`.

## How it works

1. **Before a turn,** the plugin runs each gate in `snapshot` mode with the
   session id `bb-<threadId>`. It does this on the `message.dispatch` hook. A
   thread's first turn has no worktree at dispatch, so for that turn the
   snapshot is taken on `thread.active`.
2. **After the turn,** on `thread.idle`, it runs each gate in `check` mode. If a
   gate answers `{decision: "block", reason}`, the plugin finds every agent in
   `~/.claude/agents/*.md` named in `reason`. It spawns one hidden reviewer
   thread per agent, in parallel, in the same environment, with `reason` as its
   scope. Each reviewer is read-only by instruction, and bb archives it with its
   thread.
3. **Findings** show in an **Audits** section of the thread context card (this
   needs the `threadContextCard` experiment).
   - **Apply findings** sends them to the agent as an agent-only message.
   - Asking the agent to apply them makes it call the `audit_findings` tool.

   Either way, the turn that applies them is not audited again.

The gates still decide when to audit and with what scope. They skip themselves
when `BB_THREAD_ID` is set, so inside bb they never block a turn. This plugin
runs them without that variable.

Reviewers use the thread's provider, model and permission mode.

## Storage

Runs are stored in this plugin's thread metadata namespace. The last 5 runs per
thread are kept.

The plugin has no settings and nothing in `localStorage`.
