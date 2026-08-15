/*
 * ~Alter - Pair your vault. Shared types.
 *
 * Wire-protocol shapes for the alter-runtime daemon, plugin settings,
 * and pairing-ceremony state. Mirrors the JSONL contract; if the local
 * companion server publishes a different shape, this file is the single
 * point of reconciliation.
 */

export type PairingState =
  | "unpaired"
  | "reading_session"
  | "confirming"
  | "granting"
  | "paired"
  | "failed";

export type MirrorCadence = "weekly" | "per-entry" | "manual-only";

export type VaultSubtag =
  | "journal"
  | "manual-note"
  | "meeting-minutes"
  | "reading-note"
  | "daily";

export interface PluginSettings {
  /** ~handle of the paired Sovereign-tier identity. Empty when unpaired. */
  pairedHandle: string;
  /** ISO-8601 timestamp at which the vault was first paired. */
  pairedAt: string;
  /** Stable hash of the vault path used as a pairing identifier. */
  vaultPathHash: string;
  /** Daemon socket / named-pipe path. Defaults derived per-OS. */
  daemonSocketPath: string;
  /** Cadence at which Mirror reflection is rendered into ~Alter/. */
  mirrorCadence: MirrorCadence;
  /** Vault subtags the member has consented to be inferred from. */
  consentedSubtags: VaultSubtag[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  pairedHandle: "",
  pairedAt: "",
  vaultPathHash: "",
  daemonSocketPath: "",
  mirrorCadence: "weekly",
  consentedSubtags: ["journal", "manual-note"],
};

/* --- Daemon wire protocol -------------------------------------------------
 *
 * Reconciled 2026-04-25 against the daemon protocol doc. Wire frame is
 * JSON-RPC-style
 * with a `method` + `kind` discriminator and `payload` body - NOT a flat
 * `{op, ...}` shape. Stream identifiers are canonicalised as
 * `obsidian-vault/<subtag>` (hyphenated, with a per-subtag suffix) - never
 * `obsidian_vault` alone. Each consent grant is per-subtag.
 *
 * `op` values inside the response shapes below are local
 * routing tags; the wire-level discriminator is the daemon's
 * `{ok, ingested|error}` reply.
 */

/** Canonical stream tag for an Obsidian vault subtag. */
export type ObsidianStream = `obsidian-vault/${VaultSubtag}`;

export function obsidianStream(subtag: VaultSubtag): ObsidianStream {
  return `obsidian-vault/${subtag}` as ObsidianStream;
}

export interface VaultConsentGrantRequest {
  method: "ingest";
  kind: "vault_consent_grant";
  payload: {
    user_id: string;
    stream: ObsidianStream;
    vault_path_hash: string;
    purposes: string[];
  };
}

export interface VaultConsentGrantResponse {
  /** Local routing tag - see DaemonClient.request matching. */
  op: "vault_consent_grant_response";
  ok: true;
  event_id: string;
  revocation_token: string;
  granted_at: string;
}

export interface VaultConsentRevokeRequest {
  method: "ingest";
  kind: "vault_consent_revoke";
  payload: {
    user_id: string;
    stream: ObsidianStream;
    revocation_token: string;
  };
}

export interface VaultConsentRevokeResponse {
  /** Local routing tag - see DaemonClient.request matching. */
  op: "vault_consent_revoke_response";
  ok: true;
  revoked: boolean;
  revoked_at: string;
}

export interface MirrorRequest {
  method: "ingest";
  kind: "mirror_request";
  payload: {
    user_id: string;
    since: string;
  };
}

export interface MirrorChunk {
  /** Local routing tag - emitted by DaemonClient on streamed mirror frames. */
  op: "mirror_chunk";
  type: "theme" | "consequence" | "summary";
  body: string;
  ts: string;
  /** Identifier for THEMES/<slug>.md or CONSEQUENCES/<date>.md. */
  ref?: string;
}

export interface DaemonError {
  op: "error";
  ok: false;
  code?: string;
  error: string;
  message?: string;
}

export type DaemonMessage =
  | VaultConsentGrantResponse
  | VaultConsentRevokeResponse
  | MirrorChunk
  | DaemonError;

/** Session-file shape produced by `alter login`. Mirrors the alter-cli
 *  session schema - keys must match exactly. Only `handle` + `user_id`
 *  are required by the pairing flow; the timestamp fields are surfaced
 *  for diagnostics.
 *
 *  Route-1 egress (daemonless) reads `member_api_key` and
 *  passes it as `X-ALTER-API-Key` when calling the MCP server. The `jwt`
 *  field is the OAuth access token; it is NOT used for MCP tools/call. */
export interface AlterSession {
  handle: string;
  user_id: string;
  /**
   * Layer-0 member credential — a member-scoped MCP API key minted by
   * `POST /api/v1/auth/member-key` after OAuth. Consumers present it as
   * `X-ALTER-API-Key` when calling the public MCP server. Optional for
   * backwards compat: sessions created before the endpoint existed won't
   * carry this field; Route-1 egress queues to retry buffer in that case.
   */
  member_api_key?: string;
  /** OAuth access token (three-segment compact JWS). NOT used for MCP. */
  jwt?: string;
  logged_in_at?: string;
  jwt_expires_at?: string;
}
