# Background audits

Runs your Claude Code review gates in bb without blocking turns or filling the
conversation.

By default the gates are `~/.claude/hooks/effect-review-gate.sh` and
`~/.claude/hooks/naming-review-gate.sh`.

## How it works

1. **Before a turn,** the plugin runs each gate in `snapshot` mode with the
   session id `bb-<threadId>`. It does this on the `message.dispatch` hook. A
   thread's first turn has no worktree at dispatch, so for that turn the
   snapshot is taken on `thread.active`.
2. **After the turn,** on `thread.idle`, it runs each gate in `check` mode. If a
   gate answers `{decision: "block", reason}`, the plugin finds every agent in
   the agents directory (`<name>.md`) named in `reason`. It spawns one hidden reviewer
   thread per agent, in parallel, in the same environment, with `reason` as its
   scope. Each reviewer is read-only by instruction, and bb archives it with its
   thread.
3. **Findings** are sent to the agent as an agent-only message as soon as every
   reviewer finishes, queued behind any turn in progress. The agent fixes them
   right away and ends with one line per finding. You review the diff and revert
   what you don't want. The turn that applies findings is not audited again.

   With **Apply automatically** off, findings wait in an **Audits** section of
   the thread context card (this needs the `threadContextCard` experiment). From
   there, **Apply findings** sends them, or you can ask the agent to apply them,
   and it calls the `audit_findings` tool.

The gates still decide when to audit and with what scope. They skip themselves
when `BB_THREAD_ID` is set, so inside bb they never block a turn. This plugin
runs them without that variable.

Reviewers use the thread's provider, model and permission mode.

## Settings

Settings are under Settings → Installed plugins, or `bb plugin config background-audits`.

| Setting | Default | What it does |
| --- | --- | --- |
| `gateScripts` | `~/.claude/hooks/effect-review-gate.sh` and `~/.claude/hooks/naming-review-gate.sh` | Gate scripts, one path per line (`~` allowed). Each is called as `<script> snapshot` and `<script> check`, with Claude's hook JSON on stdin. A missing script is skipped. |
| `agentsDir` | `~/.claude/agents` | Where the agents the gates name live, as `<name>.md`. |
| `autoApply` | `true` | Send findings to the agent as soon as the audit finishes. |

## Storage

Runs are stored in this plugin's thread metadata namespace. The last 5 runs per
thread are kept.

The plugin keeps nothing in `localStorage`.
