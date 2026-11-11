# bb-plugin-worktrunk

Adds a **Worktrunk** choice to bb's New Thread environment picker. Instead of
bb's built-in worktree logic, the thread's worktree comes from your own
[worktrunk](https://worktrunk.dev) (`wt`) config:

- **Location** — your `worktree-path` templates (global or per project).
- **Setup** — your `pre-start` hooks run before the agent starts, and their
  output streams into the provisioning log; `post-start` hooks run as usual.
- **Approvals** — worktrunk's own approval store. Unapproved project hooks
  fail the launch with wt's message unless *Auto-approve project hooks* is on.
- **Cleanup** — archiving the last thread runs `wt remove <branch>` (merged
  branches deleted, dirty worktrees kept), or nothing with *Keep*.

## Use

- **UI:** New thread → environment picker → *Worktrunk*. Optionally type a
  branch (empty: bb's suggested name) and a base (empty: wt's default branch).
- **CLI:**

```sh
bb thread spawn --project <id> --environment-provider worktrunk \
  --environment-inputs '{"branch":"feat/x"}' --prompt "..."
bb worktrunk doctor --host <host-id>   # which wt bb runs
```

wt runs through your login shell (`$SHELL -lc`) so hooks see your PATH
(direnv, nix). wt itself is looked up on that PATH, then in Homebrew, cargo and
nix profile dirs; set *wt path* to override.

Server state: one `bb.storage.kv` row per launch (branch and checkout), so
retries reuse the same branch and cleanup works after a failed hook.

## Develop

```sh
npm install --include=dev
./node_modules/.bin/tsc -p tsconfig.json
bb plugin build . && bb plugin install . --yes
```
