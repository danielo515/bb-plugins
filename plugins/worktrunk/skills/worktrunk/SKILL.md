---
name: worktrunk
description: Spawn a bb thread into a new git worktree created by the user's worktrunk (wt) config, using the Worktrunk environment provider. Use when the user wants threads in worktrees that follow their wt paths and hooks.
---

# Worktrunk environment

The Worktrunk plugin adds a **Worktrunk** environment choice. bb runs
`wt -C <project checkout> switch [--create] <branch> --no-cd --format json` on the
machine, through the user's login shell, so worktrunk's `worktree-path`
template and `pre-start` / `post-start` hooks decide where the worktree lives
and how it is prepared. Hook output streams into the thread's provisioning log.

## Spawn

```sh
bb thread spawn --project <id> --environment-provider worktrunk \
  --environment-inputs '{"branch":"feat/login","base":"main"}' --prompt "..."
```

Both inputs are optional: `{}` uses bb's suggested branch name and wt's default
base. An existing branch is checked out without `--create`; an existing
worktree for it is attached and never removed by bb.

## Lifecycle

- Only worktrees this plugin created are torn down. When the last thread is
  archived (after bb's 5-minute grace), it runs `wt remove <branch>`, which
  keeps unmerged branches and refuses dirty worktrees. A refused removal is
  logged and the worktree stays.
- Restoring an archived thread runs `wt switch <branch>` again.

## Settings (`bb plugin config worktrunk set <key> <value>`)

| Key | Default | Effect |
| --- | --- | --- |
| `wtPath` | `""` | Absolute wt path. Empty: login-shell PATH, then Homebrew, cargo, nix. |
| `shell` | `""` | Login shell that runs wt. Empty: `$SHELL`. |
| `approveHooks` | `false` | Pass `--yes`. Off: unapproved project hooks fail the launch; approve them with `wt config approvals add`. |
| `onArchive` | `remove` | `keep` never runs `wt remove`. |

## Troubleshoot

`bb worktrunk doctor --host <host-id>` prints which wt binary bb will run.
