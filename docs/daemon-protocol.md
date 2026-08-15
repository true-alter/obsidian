# ~Alter daemon protocol - Obsidian plugin half

> **Status:** scaffold. The companion ~Alter daemon owns the
> authoritative wire contract; this file is a thin pointer plus the
> plugin-side addendum.

## Authoritative spec

See the companion daemon's protocol doc for:

- Transport (Unix-domain socket / named pipe, `0o600` mode, JSONL).
- Default socket paths (Linux `${XDG_RUNTIME_DIR}/alter.sock`, macOS
  `~/Library/Application Support/alter/runtime.sock`, Windows
  `\\.\pipe\alter-runtime`).
- Wire frame `{"method":"ingest","kind":"<op>","payload":{...}}`.
- Response shape `{"ok":true,"ingested":true}` / `{"ok":false,"error":"<reason>"}`.
- Daemon-side coordination items (forwarder routing, defence-in-depth
  checks, freshness tracking).

The plugin client (`src/daemon-client.ts`) and shared type module
(`src/types.ts`) point at the same default socket paths via
`defaultSocketPath()` - kept in lock-step with the companion daemon's
socket-path resolver by the regression test
`tests/daemon-client.test.ts` (alignment block).

## Plugin-side addendum

The plugin issues two `kind` values that the MCP server does not (it owns
the *grant* and *grant-from-plugin* path; the MCP server owns *inference
emission*):

### `vault_consent_grant`

```jsonl
{
  "method": "ingest",
  "kind": "vault_consent_grant",
  "payload": {
    "member_id": "m-...",
    "stream": "obsidian-vault/journal",
    "vault_path_hash": "sha256-hex of vault basePath",
    "purposes": [
      "mirror_reflection",
      "identity_income",
      "search_amplification",
      "side_quest_nudge"
    ]
  }
}
```

`stream` is canonical `obsidian-vault/<subtag>` (hyphenated, with a
per-subtag suffix). One ledger row per subtag.

The four `purposes` strings are the canonical set the backend consent
ledger accepts. They MUST match exactly; the ledger refuses unknown values.

Response:

```jsonl
{
  "ok": true,
  "ingested": true,
  "event_id": "evt-...",
  "revocation_token": "opaque, plaintext, shown ONCE",
  "granted_at": "2026-04-25T12:00:00Z"
}
```

The plaintext token is rendered in a one-shot Obsidian Notice modal. Only
its SHA-256 hash is persisted in `data.json` and `~Alter/PAIRING.md` (in a
per-subtag map).

### `vault_consent_revoke`

```jsonl
{
  "method": "ingest",
  "kind": "vault_consent_revoke",
  "payload": {
    "member_id": "m-...",
    "stream": "obsidian-vault/journal",
    "revocation_token": "opaque-plaintext-shown-once-at-grant"
  }
}
```

Plaintext is required - the ledger compares hashes via
`secrets.compare_digest`. If the user did not save the plaintext, the
plugin surfaces a Notice telling them to use `alter unpair obsidian`
(CLI) or paste their saved token, and PRESERVES local pairing state so
re-attempts remain possible (GDPR Art 7(3)).

Response:

```jsonl
{ "ok": true, "ingested": true, "revoked": true, "revoked_at": "2026-04-25T13:00:00Z" }
```

### `mirror_request` (streamed)

Mirror chunks remain unsolicited streamed JSON objects with their own
`op:"mirror_chunk"` discriminator; they are NOT request/response.

```jsonl
{ "op": "mirror_chunk", "type": "summary",     "body": "...", "ts": "..." }
{ "op": "mirror_chunk", "type": "theme",       "body": "...", "ts": "...", "ref": "Recognition Over Qualification" }
{ "op": "mirror_chunk", "type": "consequence", "body": "...", "ts": "...", "ref": "2026-04-25" }
```

### Errors

```jsonl
{ "ok": false, "error": "consent_denied" }
```

Plugin behaviour: rejects the in-flight request, surfaces a Notice,
remains connected.

## Privacy and consent

- **On-device:** every op above runs against the local daemon; vault
  content never traverses the network from this plugin. Only consented
  inferences leave the device.
- **Provenance:** all inferences carry `provenance = passive_local_document`.
- **Return:** every accepted grant produces vault-side return events
  rendered into `~Alter/`.
- **Prohibited contexts:** emotion inference is not part of the default
  `purposes` set; the daemon must reject any op that requests it in
  workplace/education modes (EU AI Act Art 5(1)(d)).
- **Stream-specific basis:** each `vault_consent_grant` records a fresh,
  documented, revocable Art 6(1)(a) consent, separate from any other
  stream the member has already paired. Per-subtag granularity is the
  unit of consent.

## Versioning

- Scaffold = v0.1 - protocol shape may shift before v1.
- Bumps follow the companion daemon's protocol version; the
  plugin reads `daemon_protocol_version` from the first response op once
  the daemon ships it.
