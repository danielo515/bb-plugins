# Reviewed Files

Mark a file as reviewed in BB's diff view so you stop re-reading it — and have
that mark disappear as soon as an agent turn changes the file again.

GitHub's "viewed" checkbox assumes a static PR. In BB the agent keeps editing
underneath you, so a sticky mark would hide new work. Here a mark means "I
reviewed *this version*": it is stored as the file path plus a fingerprint of the
diff content that was reviewed. When a later turn edits the file its patch
changes, the fingerprint no longer matches, and the file expands again on its
own. No invalidation pass, no staleness.

## What it does

- Replaces BB's diff renderer (`experimental_diffRenderer`) with the same diff
  plus a **Reviewed** checkbox — in the environment diff panel, timeline file
  diffs, and file previews.
- Ticking it hides the diff body and leaves a one-line summary
  (`Reviewed — hidden until this file changes again  +12 −3`).
- The mark clears automatically when the file's diff changes.
- Command palette (`Mod+Shift+P`): **Reviewed files: clear all review marks**.

## Install

```
npm install --include=dev   # or any package manager; dev deps are needed to build
bb plugin build
bb plugin install .
```

Reload after editing: `bb plugin reload reviewed-files`, or run
`bb plugin dev` for rebuild-on-save.

To pin or unpin the renderer, use **Settings → Appearance → Diffs**; disabling
the plugin falls back to BB's own renderer.

## Notes and limits

- Marks are **per client** (localStorage, like BB's own renderer choice), not
  synced across machines, and capped at 2000 entries.
- Marks are keyed by path, not by thread: the same path reviewed at identical
  content in two threads counts as reviewed in both. The fingerprint makes that
  safe in practice — same path *and* same diff really is the same review.
- The file row's own header is BB's; this plugin owns the body, so a reviewed
  file still lists in the diff panel, just collapsed. Filtering the list to
  unreviewed files needs host support — see
  [get-bb/bb#2598](https://github.com/get-bb/bb/issues/2598).
- Frontend-only: `server.ts` exists because the manifest requires an entry.
