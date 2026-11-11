# bb-plugin-existing-worktree

Adds an **Existing worktree** choice to bb's New Thread environment picker.
Pick any git worktree that already exists for the project checkout (created by
`git worktree add`, worktrunk, Claude Code, Herdr, ...) and the thread runs
there. bb attaches the directory without owning it: no `.bb-env-setup.sh` or
teardown hook runs and the worktree is never removed.

## Install

```sh
bb plugin install /path/to/bb-plugin-existing-worktree
```

## Use

- **UI:** New thread → environment picker → *Existing worktree* → choose a
  worktree in the chip beside the picker.
- **CLI:**

```sh
bb existing-worktree list --project <project-id> --host <host-id> [--json]
bb thread spawn --project <project-id> \
  --environment-provider existing-worktree \
  --environment-inputs '{"path":"/abs/path/to/worktree"}' \
  --prompt "..."
```

A path that is not a worktree of the project checkout is refused before the
thread is created.

## Develop

```sh
npm install --include=dev
bb plugin build .
bb plugin install . --yes   # or: bb plugin dev
```
