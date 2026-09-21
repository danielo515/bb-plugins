# bb-plugins

My [bb](https://github.com/get-bb/bb) customizations, kept here so a new machine
is a few commands rather than an archaeology session.

| What | Where |
| --- | --- |
| `reviewed-files` plugin — "Reviewed" checkbox in the diff view that clears when an agent changes the file | [`plugins/reviewed-files`](plugins/reviewed-files) |
| `wide` theme — default palette, main panel stretched to the full window width | [`theme/wide`](theme/wide) |

## Reinstall on a new machine

Plugins — installed straight from this repo, no clone needed:

```sh
bb plugin install git:https://github.com/danielo515/bb-plugins.git@main --plugin reviewed-files
```

`--plugin <name>` resolves an entry from [`.bb/plugins.json`](.bb/plugins.json);
`--subdirectory plugins/reviewed-files` does the same without the manifest. Git
installs need `npm` on `PATH` (bb runs `npm install` and builds the bundles).

Themes are read from the bb data dir, so they get copied rather than installed:

```sh
git clone https://github.com/danielo515/bb-plugins.git
cp -R bb-plugins/theme/wide "$(bb theme dir)/wide"
bb theme set wide
```

## Working on a plugin locally

```sh
cd plugins/reviewed-files
npm install --include=dev
bb plugin install .        # path install: bb loads this directory in place
bb plugin dev              # rebuild + reload on save
```

A path install points at wherever the directory lives, so keep the clone
somewhere permanent.

## Adding another plugin

```sh
bb plugin new <name>       # creates bb-plugin-<name>/
mv bb-plugin-<name> plugins/<name>
```

Then add an entry to `.bb/plugins.json`. Each plugin has its own
`package.json` and version; if you ever want ranged git installs
(`@semver:^0.1.0`), tag per plugin with its own prefix — `reviewed-files/v0.1.0`
— and install with `--tag-prefix reviewed-files/`.
