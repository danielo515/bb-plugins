# Working in this repo

A bb plugin collection. Each plugin is a self-contained package under
`plugins/<name>/` with its own `package.json`; `.bb/plugins.json` indexes them so
`bb plugin install … --plugin <name>` resolves a name. `theme/<name>/theme.css`
holds app themes, which are copied into `$(bb theme dir)` rather than installed.

Load the `bb-plugin-authoring` skill before writing plugin code — the installed
bb version, not memory, defines the SDK. Every new SDK surface it exposes is
`experimental_`-prefixed and may change between releases.

## Add a plugin

```sh
bb plugin new <name>              # scaffolds ./bb-plugin-<name>
mv bb-plugin-<name> plugins/<name>
cd plugins/<name> && npm install --include=dev
```

Then:

1. Add `{ "name": "<name>", "source": "./plugins/<name>" }` to
   `.bb/plugins.json`.
2. Strip the scaffold's todo example (`server.ts`, `app.tsx`,
   `skills/example-todos/`) and its unused vendored `components/ui/*`. Keep only
   what the plugin imports — the vendored components are yours to edit or
   delete, but a deleted one that another vendored file imports breaks the build
   (`components/ui/dialog.tsx` needs `hooks/useBrowserDimmingModal.ts`).
3. Set `bb.name`, `bb.description`, `bb.branding.icon`, and `bb.skills: []` when
   the plugin ships no skills. Drop dependencies the scaffold added that the
   plugin does not use.
4. Add a row to the table in `README.md`.

## Verify before committing

```sh
cd plugins/<name>
./node_modules/.bin/tsc -p tsconfig.json   # must be clean
bb plugin build                            # emits dist/
bb plugin install .                        # or: bb plugin install path:../.. --plugin <name>
bb plugin list | grep -A1 '^<name>'        # expect "running"
tail ~/.bb/plugins/<name>/logs/plugin.log  # the plugin's own log
```

A path install loads the directory in place, so local edits take effect on
`bb plugin reload <name>` (or continuously under `bb plugin dev`). Installing the
same plugin from `git:` instead pins it to what is pushed — fine for other
machines, confusing while developing here.

## Conventions

- Frontend styling uses host token classes (`bg-card`, `text-muted-foreground`,
  `border-border`, …). Never hardcode colors or declare custom `@theme` colors:
  it breaks custom palettes.
- Treat anything persisted or passed into a frontend slot as untrusted input and
  validate its shape on read.
- Per-client UI state belongs in `localStorage`; server-side state belongs in
  `bb.storage`. Say which one a plugin uses in its README.
- Dependency placement is load-bearing: packages bb shims at runtime (react,
  sonner, the portal radix families, clsx, tailwind-merge,
  class-variance-authority, `@pierre/diffs`) are **type-only devDependencies** at
  the host's version. Anything imported at runtime and not shimmed goes in
  `dependencies`. `bb plugin types` repins these.
- Tag releases per plugin with the plugin's own prefix — `<name>/v1.2.3` — so
  ranged git installs can target one plugin.
