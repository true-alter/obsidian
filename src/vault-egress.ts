/**
 * vault-egress.ts: daemonless egress (Route 1)
 *
 * Posts capped, engine-derived trait signals directly to the backend
 * `vault_ingest` MCP tool over HTTPS using the session credential the
 * CLI writes at ~/.config/alter/session.json.
 *
 * Responsibilities:
 *   1. Batch signals at the 256-per-call ceiling (_MAX_INFERENCES_PER_CALL).
 *   2. POST each batch to vault_ingest via JSON-RPC tools/call.
 *   3. On failure, enqueue to the retry buffer persisted in data.json.
 *   4. On success / next run, drain the retry buffer.
 *
 * NEVER sends vault content — only the engine's capped derived signals.
 * Confidence cap (0.30), source_tier (2), and provenance_class
 * ("passive_local_document") are preserved verbatim from the engine output;
 * this layer does NOT re-stamp or relax them.
 *
 * Auth: reads `member_api_key` from AlterSession and passes it as the
 * `X-ALTER-API-Key` header — mirroring how the CLI calls the MCP server.
 * The JWT is NOT used here; the member API key is the right credential
 * for MCP tools/call.
 */

import { requestUrl } from "obsidian";
import type { TraitSignal } from "./vault-trait-engine/types";
import type { MethodAuditLedgerRow } from "./alter-folder";
import type { AlterSession } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches backend _MAX_INFERENCES_PER_CALL. */
export const MAX_INFERENCES_PER_CALL = 256;

/**
 * Hard cap on the number of retry-buffer entries persisted in data.json. On
 * overflow the OLDEST entries are dropped (oldest-first ordering is preserved
 * so drain semantics are unchanged). Bounds unbounded growth when the backend
 * is unreachable for an extended period.
 */
export const MAX_RETRY_BUFFER_ENTRIES = 50;

/** MCP endpoint path — mounted at /api/v1/mcp on the backend. */
const MCP_PATH = "/api/v1/mcp";

/** data.json key for the egress retry buffer. */
export const RETRY_BUFFER_KEY = "__alter_vault_egress_retry" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One item in the retry buffer. Each item is a single batch payload. */
export interface RetryBufferEntry {
  member_id: string;
  inferences: TraitSignal[];
  queued_at: string; // ISO-8601
}

/** I/O and HTTP deps, injected for testability. */
export interface VaultEgressDeps {
  /** Read the retry buffer from plugin data. Returns [] on missing/corrupt. */
  loadRetryBuffer: () => Promise<RetryBufferEntry[]>;
  /** Persist the retry buffer to plugin data. */
  saveRetryBuffer: (entries: RetryBufferEntry[]) => Promise<void>;
  /** HTTP POST — production uses Obsidian requestUrl; tests inject. */
  postJson: (
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ) => Promise<{ ok: boolean; status: number; body: unknown }>;
  /**
   * Append a single method_audit row to the local ~Alter/ ledger.
   * Called for each signal BEFORE the stripped payload is sent
   * to the backend so derivation provenance is durably persisted on-device.
   * Optional — when absent the ledger step is skipped (e.g. legacy call sites
   * before AlterFolder is wired). Production wires AlterFolder.appendMethodAudit.
   */
  appendMethodAuditRow?: (row: MethodAuditLedgerRow) => Promise<void>;
}

// ---------------------------------------------------------------------------
// MCP envelope builder
// ---------------------------------------------------------------------------

/**
 * Build the JSON-RPC 2.0 tools/call envelope for vault_ingest.
 * Wire shape matches backend vault_ingest params (vault_ingest.py §input schema):
 *   member_id: str
 *   inferences: list[{trait_name, value, confidence, provenance_class,
 *                      stream_subtag, source_digest}]
 * NOTE: method_audit is NOT sent, the backend schema does not accept it and
 * would reject the batch. It is an engine-internal audit field only.
 */
export function buildVaultIngestEnvelope(
  memberId: string,
  inferences: TraitSignal[],
): object {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "vault_ingest",
      arguments: {
        member_id: memberId,
        inferences: inferences.map((s) => ({
          trait_name: s.trait_name,
          value: s.value,
          confidence: s.confidence,
          provenance_class: s.provenance_class,
          stream_subtag: s.stream_subtag,
          source_digest: s.source_digest,
          // method_audit intentionally excluded — backend schema rejects it.
        })),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Obsidian-native HTTP POST helper (production)
// ---------------------------------------------------------------------------

/**
 * Build a VaultEgressDeps.postJson backed by Obsidian's requestUrl.
 * Falls back to fetch when requestUrl is unavailable (test environments).
 */
export function obsidianPostJson(): VaultEgressDeps["postJson"] {
  return async (url, body, headers) => {
    const allHeaders = { ...headers, "content-type": "application/json" };
    if (typeof requestUrl === "function") {
      const resp = await requestUrl({
        url,
        method: "POST",
        headers: allHeaders,
        body: JSON.stringify(body),
        throw: false,
      });
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        body: resp.json ?? null,
      };
    }
    // fetch fallback (tests / environments without requestUrl)
    const resp = await fetch(url, {
      method: "POST",
      headers: allHeaders,
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await resp.json();
    } catch {
      // ignore parse failure
    }
    return { ok: resp.ok, status: resp.status, body: parsed };
  };
}

// ---------------------------------------------------------------------------
// Core egress: POST one batch
// ---------------------------------------------------------------------------

/**
 * POST a single batch of inferences to vault_ingest.
 * Returns true on success (2xx, no isError), false on any failure.
 *
 * Does NOT mutate the retry buffer — caller handles that.
 */
export async function postBatch(
  apiBase: string,
  memberId: string,
  inferences: TraitSignal[],
  apiKey: string,
  clientVersion: string,
  deps: Pick<VaultEgressDeps, "postJson">,
): Promise<boolean> {
  const url = `${apiBase.replace(/\/$/, "")}${MCP_PATH}`;
  const envelope = buildVaultIngestEnvelope(memberId, inferences);
  const headers: Record<string, string> = {
    "X-ALTER-API-Key": apiKey,
    "X-Alter-Client-Id": "alter-obsidian",
    "X-Alter-Client-Version": clientVersion,
  };

  try {
    const resp = await deps.postJson(url, envelope, headers);
    if (!resp.ok) return false;
    // Check for MCP-level error flag
    const body = resp.body as Record<string, unknown> | null;
    const result = body?.result as Record<string, unknown> | undefined;
    if (result?.isError) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public egress API
// ---------------------------------------------------------------------------

/**
 * Run egress for a subtag: derive → filter (done by caller) → POST.
 *
 * 1. Split signals into batches of MAX_INFERENCES_PER_CALL.
 * 2. POST each batch. On failure, enqueue to retry buffer.
 * 3. Drain any existing retry buffer entries (best-effort, oldest-first).
 *
 * @param apiBase       e.g. "https://api.truealter.com"
 * @param session       The CLI session (provides member_api_key + user_id)
 * @param signals       The filterToSinkAccepted()-filtered signals to emit.
 * @param clientVersion Plugin version string for X-Alter-Client-Version.
 * @param deps          I/O deps (retry buffer + postJson).
 */
export async function runEgress(
  apiBase: string,
  session: AlterSession,
  signals: TraitSignal[],
  clientVersion: string,
  deps: VaultEgressDeps,
): Promise<void> {
  const apiKey = session.member_api_key;

  // Persist method_audit to the local ~Alter/ ledger BEFORE
  // the stripped payload is sent to the backend. This runs unconditionally
  // (even when there is no apiKey) so provenance is never silently discarded.
  // source_digest is the link key: the backend record carries it; the ledger
  // row carries the full method_audit.
  if (deps.appendMethodAuditRow) {
    const recordedAt = new Date().toISOString();
    for (const signal of signals) {
      await deps.appendMethodAuditRow({
        source_digest: signal.source_digest,
        trait_name: signal.trait_name,
        stream_subtag: signal.stream_subtag,
        method_audit: signal.method_audit,
        recorded_at: recordedAt,
      });
    }
  }

  if (!apiKey) {
    // No member API key — enqueue everything to retry buffer for later drain.
    await enqueueToRetryBuffer(deps, session.user_id, signals);
    return;
  }

  // Batch and POST new signals
  for (let offset = 0; offset < signals.length; offset += MAX_INFERENCES_PER_CALL) {
    const batch = signals.slice(offset, offset + MAX_INFERENCES_PER_CALL);
    const ok = await postBatch(apiBase, session.user_id, batch, apiKey, clientVersion, deps);
    if (!ok) {
      await enqueueToRetryBuffer(deps, session.user_id, batch);
    }
  }

  // Drain retry buffer (best-effort)
  await drainRetryBuffer(apiBase, session.user_id, apiKey, clientVersion, deps);
}

/**
 * Drain the retry buffer: attempt to POST each queued entry in order.
 * On success, remove from buffer. On failure, leave in place (will retry next run).
 */
export async function drainRetryBuffer(
  apiBase: string,
  memberId: string,
  apiKey: string,
  clientVersion: string,
  deps: VaultEgressDeps,
): Promise<void> {
  const buffer = await deps.loadRetryBuffer();
  if (buffer.length === 0) return;

  const remaining: RetryBufferEntry[] = [];
  for (const entry of buffer) {
    // Only drain entries for this member_id (defensive)
    if (entry.member_id !== memberId) {
      remaining.push(entry);
      continue;
    }
    // Batch within MAX_INFERENCES_PER_CALL
    for (let offset = 0; offset < entry.inferences.length; offset += MAX_INFERENCES_PER_CALL) {
      const batch = entry.inferences.slice(offset, offset + MAX_INFERENCES_PER_CALL);
      const ok = await postBatch(apiBase, memberId, batch, apiKey, clientVersion, deps);
      if (!ok) {
        // Keep remaining un-posted inferences in a new entry
        remaining.push({
          member_id: memberId,
          inferences: entry.inferences.slice(offset),
          queued_at: entry.queued_at,
        });
        break; // stop draining this entry; network is likely unavailable
      }
    }
  }

  await deps.saveRetryBuffer(remaining);
}

async function enqueueToRetryBuffer(
  deps: VaultEgressDeps,
  memberId: string,
  inferences: TraitSignal[],
): Promise<void> {
  if (inferences.length === 0) return;
  const buffer = await deps.loadRetryBuffer();
  buffer.push({
    member_id: memberId,
    inferences,
    queued_at: new Date().toISOString(),
  });
  // Enforce the buffer cap: drop the OLDEST entries (front of the array) so the
  // buffer never exceeds MAX_RETRY_BUFFER_ENTRIES. Ordering (oldest-first) is
  // preserved so drainRetryBuffer still drains chronologically.
  const capped =
    buffer.length > MAX_RETRY_BUFFER_ENTRIES
      ? buffer.slice(buffer.length - MAX_RETRY_BUFFER_ENTRIES)
      : buffer;
  await deps.saveRetryBuffer(capped);
}

// ---------------------------------------------------------------------------
// Direct consent grant / revoke (daemonless, member-self)
//
// Consent model: Model A (member-self). Grant and revoke
// both go to the SAME MCP endpoint the egress uses (`${apiBase}${MCP_PATH}`)
// as JSON-RPC tools/call against the `alter_consent` tool — NOT a bespoke REST
// surface. The grant returns NO revocation token; revocation authority is the
// member's own session (the caller IS the data subject). The legacy
// capability-token machinery (show-token-once → hash-store → paste-to-revoke)
// has been retired.
// ---------------------------------------------------------------------------

/**
 * Build the JSON-RPC 2.0 tools/call envelope for an `alter_consent` action.
 * Same transport/headers as `buildVaultIngestEnvelope`, different tool.
 */
export function buildAlterConsentEnvelope(args: Record<string, unknown>): object {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "alter_consent",
      arguments: args,
    },
  };
}

/**
 * Treat an MCP tools/call HTTP response as success/failure. A call fails if the
 * HTTP status is non-2xx OR the JSON-RPC result carries `isError: true`.
 * Mirrors `postBatch`'s error handling.
 */
function mcpCallFailed(resp: { ok: boolean; body: unknown }): boolean {
  if (!resp.ok) return true;
  const body = resp.body as Record<string, unknown> | null;
  const result = body?.result as Record<string, unknown> | undefined;
  return result?.isError === true;
}

/**
 * Grant consent for a vault stream directly via the `alter_consent` MCP tool.
 * Called by toggleSubtagConsent(subtag, true) and the pairing ceremony's
 * granting state instead of the daemon round-trip.
 *
 * tools/call → name="alter_consent",
 *   arguments={ action:"grant_vault", stream:"obsidian-vault/<subtag>",
 *               vault_path_hash }
 * Auth: X-ALTER-API-Key: session.member_api_key (same headers as postBatch).
 *
 * Member-self: returns NO revocation token. Resolves with `granted_at` when the
 * backend supplies it (callers may ignore it). Throws on failure.
 */
export async function directGrantConsent(
  apiBase: string,
  session: AlterSession,
  stream: string,
  vaultPathHash: string,
  clientVersion: string,
  deps: Pick<VaultEgressDeps, "postJson">,
): Promise<string> {
  const apiKey = session.member_api_key;
  if (!apiKey) {
    throw new Error("no member API key in session. Run `alter login` to refresh");
  }

  const url = `${apiBase.replace(/\/$/, "")}${MCP_PATH}`;
  const headers: Record<string, string> = {
    "X-ALTER-API-Key": apiKey,
    "X-Alter-Client-Id": "alter-obsidian",
    "X-Alter-Client-Version": clientVersion,
  };
  const envelope = buildAlterConsentEnvelope({
    action: "grant_vault",
    stream,
    vault_path_hash: vaultPathHash,
  });

  const resp = await deps.postJson(url, envelope, headers);
  if (mcpCallFailed(resp)) {
    throw new Error(`consent grant failed: HTTP ${resp.status}`);
  }
  // granted_at may live on the structured tool result; surface it best-effort.
  const body = resp.body as Record<string, unknown> | null;
  const result = body?.result as Record<string, unknown> | undefined;
  const grantedAt =
    typeof result?.granted_at === "string" ? (result.granted_at as string) : "";
  return grantedAt;
}

/**
 * Revoke consent for a vault stream directly via the `alter_consent` MCP tool.
 * Called by revokeSubtag / runUnpairCeremony / the settings revoke button
 * instead of the daemon round-trip.
 *
 * tools/call → name="alter_consent",
 *   arguments={ action:"set", stream:"obsidian-vault/<subtag>", purposes:[] }
 * Auth: X-ALTER-API-Key: session.member_api_key (same headers as postBatch).
 *
 * Member-self: authorised by the member's own session — no revocation token.
 * Throws on failure.
 */
export async function directRevokeConsent(
  apiBase: string,
  session: AlterSession,
  stream: string,
  clientVersion: string,
  deps: Pick<VaultEgressDeps, "postJson">,
): Promise<void> {
  const apiKey = session.member_api_key;
  if (!apiKey) {
    throw new Error("no member API key in session. Run `alter login` to refresh");
  }

  const url = `${apiBase.replace(/\/$/, "")}${MCP_PATH}`;
  const headers: Record<string, string> = {
    "X-ALTER-API-Key": apiKey,
    "X-Alter-Client-Id": "alter-obsidian",
    "X-Alter-Client-Version": clientVersion,
  };
  const envelope = buildAlterConsentEnvelope({
    action: "set",
    stream,
    purposes: [],
  });

  const resp = await deps.postJson(url, envelope, headers);
  if (mcpCallFailed(resp)) {
    throw new Error(`consent revoke failed: HTTP ${resp.status}`);
  }
}
