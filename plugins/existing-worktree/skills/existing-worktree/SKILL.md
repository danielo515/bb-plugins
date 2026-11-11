---
name: existing-worktree
description: Spawn a bb thread into a git worktree that already exists for the project, using the Existing worktree environment provider. Use when the user wants a thread in a worktree they created outside bb.
---

# Existing worktree

The Existing worktree plugin adds an environment choice that attaches a thread
to a git worktree of the project checkout. bb does not own the directory: no
setup or teardown hooks run and the worktree is never deleted.

## Commands

| Command | Effect |
| --- | --- |
| `bb existing-worktree list --project <id> --host <id> [--json]` | List worktrees of the project checkout on that machine. `*` marks the main checkout. |
| `bb thread spawn --project <id> --environment-provider existing-worktree --environment-inputs '{"path":"<worktree>"}' --prompt "..."` | Start a thread in that worktree. |

`--project` defaults to `BB_PROJECT_ID` inside a thread. Find host ids with
`bb machine list`.
