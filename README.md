# ~Alter for Obsidian

Obsidian community plugin - pair your vault with ~Alter.

## What this is

The return surface of the "Pair your vault" pairing. A local companion
reads the vault on-device; this plugin renders Mirror reflection back
into a dedicated `~Alter/` folder inside the vault as the per-stream
return event.

Vault content **never leaves the device**. Only consented inferences,
mediated by the local ~Alter daemon, ever traverse the network.

## Status

Pre-release. Distribution is through the ~Alter CLI (see Install below);
community-directory submission lands in a later release.

## Install

~Alter ships zero-friction installation through its CLI. From any
terminal:

```bash
alter pair obsidian
```

That single command:

- detects your Obsidian install + paired vault path,
- sideloads this plugin into `<vault>/.obsidian/plugins/alter-obsidian-plugin/`,
- ensures the daemon socket is available,
- and runs the per-subtag pairing ceremony with the local daemon.

If you don't have the CLI yet:

```bash
npx @truealter/cli pair obsidian
```

bootstraps the CLI then runs the same pairing in one go.

### Fallback - offline / restricted environments

For air-gapped, IT-locked, or development builds where the CLI is not
viable, manual install is supported but discouraged:

1. Clone or download a release of this repo.
2. Copy the built `main.js`, `manifest.json`, and `styles.css` into
   `<vault>/.obsidian/plugins/alter-obsidian-plugin/`.
3. Enable the plugin in Settings → Community plugins.
4. Run **Pair this vault to your ~handle** from the command palette.

Zero-friction install routes every supported user through
`alter pair obsidian`. Manual install is the rare exception, not the
documented norm.

## Prerequisites

- Obsidian 1.4.0 or later.
- The local ~Alter daemon running on the same machine
  (Linux/macOS/Windows). The CLI ensures this; manual installers are
  responsible for it.
- A `~handle` session - `alter pair obsidian` invokes `alter login` first
  if needed.

## How pairing works

`alter pair obsidian` runs end-to-end:

1. CLI detects your Obsidian install + vault.
2. CLI sideloads this plugin (no community-plugin-manager hand-off).
3. The plugin discovers your `~handle` from your local CLI session.
4. You confirm pairing in a modal.
5. The plugin requests one consent grant *per consented subtag*
   (granular per-subtag consent).
6. The daemon countersigns each grant and returns a one-time revocation
   token per subtag.
7. Each token is shown **once** - save it if you want offline revoke
   capability. Only the SHA-256 hashes are persisted.
8. `~Alter/PAIRING.md` is written to record the per-subtag map of hashes.

The full protocol is documented in [`docs/daemon-protocol.md`](docs/daemon-protocol.md).

## What `~Alter/` contains

Created on first pair, idempotent thereafter:

```
~Alter/
  .alter-managed         sentinel + frontmatter warning
  PAIRING.md             handle, vault hash, granted_at, purposes,
                         per-subtag revocation_token_hashes map
  MIRROR.md              rolling reflection synthesis
  INCOME.md              vault-sourced Identity Income ledger
  THEMES/<slug>.md       emergent themes
  CONSEQUENCES/<date>.md consequence previews before promotion
```

The folder name is fixed - it is the vault's identity binding. Edit files
inside `~Alter/` at your own risk; the plugin will overwrite or merge them
on subsequent reflection cycles.

## Mobile support

`isDesktopOnly: false`. On platforms where unix sockets are unavailable
(iOS, Android), the plugin surfaces a Notice that pairing requires desktop.
It does not crash; read-only Mirror viewing on mobile lands in a later
release.

## Development

```bash
npm install
npm run dev        # esbuild watch
npm run build      # production main.js
npm run test       # vitest unit tests
npm run lint
npm run typecheck
```

## Privacy

Vault inference runs entirely on-device. Only consented summaries ever
leave the machine, and every consent is per-subtag and revocable at any
time. Each inference is recorded as sourced from a passive local document.
Emotion inference is not part of the default purposes; in workplace and
education contexts the daemon enforces the EU AI Act Article 5
prohibitions.

## Licence

Apache-2.0. See `LICENSE`.
