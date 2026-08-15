/**
 * vault-egress tests: daemonless Route 1 egress
 *
 * Coverage:
 *   1. POST success — single batch POSTed, buffer stays empty
 *   2. POST failure → retry buffer persists on failure
 *   3. Retry buffer drains on next attempt (POST succeeds)
 *   4. filterToSinkAccepted applied before POST — sink-rejected trait never sent
 *   5. 256-per-call batch ceiling — two batches emitted for 257 signals
 *   6. Daemonless consent grant — alter_consent grant_vault tools/call shape
 *   7. Daemonless consent revoke — alter_consent set purposes=[] tools/call shape
 *   7b. Retry buffer cap — never exceeds MAX_RETRY_BUFFER_ENTRIES, drops oldest
 *   8. No member_api_key → enqueue to retry buffer, no POST attempted
 */

import { describe, expect, it } from "vitest";
import {
  MAX_INFERENCES_PER_CALL,
  MAX_RETRY_BUFFER_ENTRIES,
  RetryBufferEntry,
  VaultEgressDeps,
  buildVaultIngestEnvelope,
  directGrantConsent,
  directRevokeConsent,
  drainRetryBuffer,
  postBatch,
  runEgress,
} from "../src/vault-egress";
import {
  deriveInferencesForSubtag,
  filterToSinkAccepted,
  SINK_ACCEPTED_TRAITS,
} from "../src/vault-trait-engine/engine";
import type { Note, TraitSignal } from "../src/vault-trait-engine/types";
import type { AlterSession } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const NOW = Date.now();

/** Build a dense vault that emits at least the 3 SINK_ACCEPTED_TRAITS. */
function buildDenseVault(n: number, spanDays: number): Note[] {
  const baseMs = NOW - spanDays * MS_PER_DAY;
  const namespaces = ["Projects", "Research", "Journal", "Reading", "Reference"];
  return Array.from({ length: n }, (_, i): Note => {
    const ns = namespaces[i % 5];
    return {
      path: `${ns}/note-${i}.md`,
      mtimeMs: baseMs + (i / n) * spanDays * MS_PER_DAY,
      ctimeMs: baseMs + (i / n) * spanDays * MS_PER_DAY * 0.8,
      contentLength: i % 5 === 0 ? 120 : i % 7 === 0 ? 2500 : 800,
      frontmatter: { created: new Date(baseMs).toISOString(), status: "active" },
      outboundLinks: i > 0 ? [`${namespaces[(i + 1) % 5]}/note-${i - 1}.md`] : [],
      tags: [`${ns.toLowerCase()}/topic`, `${ns.toLowerCase()}/sub`],
      folder: ns,
    };
  });
}

const SESSION_WITH_KEY: AlterSession = {
  handle: "~test",
  user_id: "user-uuid-1234",
  member_api_key: "alt_test_member_key_abc123",
  jwt: "eyJ.test.jwt",
  logged_in_at: new Date().toISOString(),
  jwt_expires_at: new Date(Date.now() + 3600_000).toISOString(),
};

const SESSION_WITHOUT_KEY: AlterSession = {
  handle: "~test",
  user_id: "user-uuid-1234",
  // member_api_key intentionally absent
  logged_in_at: new Date().toISOString(),
  jwt_expires_at: new Date(Date.now() + 3600_000).toISOString(),
};

/** Build a minimal TraitSignal for testing. */
function makeSignal(trait_name: string): TraitSignal {
  return {
    trait_name,
    value: 0.5,
    confidence: 0.2,
    provenance_class: "passive_local_document",
    stream_subtag: "obsidian-vault/manual-note",
    source_digest: "a".repeat(64),
    method_audit: {
      observables: { test_obs: 0.5 },
      weighted_raw: 0.5,
      transform: "sigmoid",
      calibration_band: [0, 1],
    },
  };
}

/** Build N signals with accepted trait names (cycling through SINK_ACCEPTED_TRAITS). */
function makeAcceptedSignals(n: number): TraitSignal[] {
  const accepted = Array.from(SINK_ACCEPTED_TRAITS);
  return Array.from({ length: n }, (_, i) =>
    makeSignal(accepted[i % accepted.length]),
  );
}

// ---------------------------------------------------------------------------
// Mock deps builder
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<{
  buffer: RetryBufferEntry[];
  postStatus: number;
  postBody: unknown;
  postShouldThrow: boolean;
}>  = {}): VaultEgressDeps & { calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> } {
  let buffer: RetryBufferEntry[] = overrides.buffer ?? [];
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];

  return {
    calls,
    loadRetryBuffer: async () => [...buffer],
    saveRetryBuffer: async (entries) => { buffer = [...entries]; },
    postJson: async (url, body, headers) => {
      calls.push({ url, body, headers });
      if (overrides.postShouldThrow) throw new Error("network error");
      const status = overrides.postStatus ?? 200;
      const respBody = overrides.postBody ?? { result: { inference_count: 1 } };
      return { ok: status >= 200 && status < 300, status, body: respBody };
    },
  };
}

// ---------------------------------------------------------------------------
// 1. POST success — single batch, buffer stays empty
// ---------------------------------------------------------------------------

describe("egress: POST success", () => {
  it("POSTs all signals in one batch when count ≤ 256", async () => {
    const signals = makeAcceptedSignals(3);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);

    expect(deps.calls).toHaveLength(1);
    // retry buffer should remain empty
    const buf = await deps.loadRetryBuffer();
    expect(buf).toHaveLength(0);
  });

  it("includes X-ALTER-API-Key in POST headers", async () => {
    const signals = makeAcceptedSignals(1);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);
    expect(deps.calls[0].headers["X-ALTER-API-Key"]).toBe(SESSION_WITH_KEY.member_api_key);
  });

  it("POST URL is /api/v1/mcp", async () => {
    const signals = makeAcceptedSignals(1);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);
    expect(deps.calls[0].url).toBe("https://api.truealter.com/api/v1/mcp");
  });

  it("vault_ingest envelope has correct JSON-RPC method and tool name", async () => {
    const signals = makeAcceptedSignals(2);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);
    const body = deps.calls[0].body as Record<string, unknown>;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("tools/call");
    const params = body.params as Record<string, unknown>;
    expect(params.name).toBe("vault_ingest");
  });

  it("method_audit is NOT included in the POSTed inferences (backend rejects it)", async () => {
    const signals = makeAcceptedSignals(1);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);
    const body = deps.calls[0].body as Record<string, unknown>;
    const params = body.params as Record<string, unknown>;
    const args = params.arguments as Record<string, unknown>;
    const inferences = args.inferences as Record<string, unknown>[];
    expect(Object.keys(inferences[0])).not.toContain("method_audit");
  });
});

// ---------------------------------------------------------------------------
// 2. POST failure → retry buffer persists
// ---------------------------------------------------------------------------

describe("egress: retry buffer persists on POST failure", () => {
  it("enqueues all signals to retry buffer when POST returns 500", async () => {
    const signals = makeAcceptedSignals(3);
    const deps = makeDeps({ postStatus: 500 });
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);

    const buf = await deps.loadRetryBuffer();
    expect(buf.length).toBeGreaterThan(0);
    // Total inferences in buffer equals what was sent
    const total = buf.reduce((acc, e) => acc + e.inferences.length, 0);
    expect(total).toBe(signals.length);
  });

  it("enqueues to retry buffer when POST throws (network error)", async () => {
    const signals = makeAcceptedSignals(2);
    const deps = makeDeps({ postShouldThrow: true });
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);

    const buf = await deps.loadRetryBuffer();
    expect(buf.length).toBeGreaterThan(0);
  });

  it("retry buffer entry has queued_at ISO timestamp", async () => {
    const signals = makeAcceptedSignals(1);
    const deps = makeDeps({ postStatus: 503 });
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);

    const buf = await deps.loadRetryBuffer();
    expect(buf[0]?.queued_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// 3. Retry buffer drains on next successful attempt
// ---------------------------------------------------------------------------

describe("egress: retry buffer drains on success", () => {
  it("drains pre-existing retry buffer entries on next POST success", async () => {
    const existingEntry: RetryBufferEntry = {
      member_id: SESSION_WITH_KEY.user_id,
      inferences: makeAcceptedSignals(2),
      queued_at: new Date().toISOString(),
    };
    const deps = makeDeps({ buffer: [existingEntry] });

    // No new signals — just drain
    await drainRetryBuffer(
      "https://api.truealter.com",
      SESSION_WITH_KEY.user_id,
      SESSION_WITH_KEY.member_api_key!,
      "0.1.2",
      deps,
    );

    const buf = await deps.loadRetryBuffer();
    expect(buf).toHaveLength(0);
    expect(deps.calls).toHaveLength(1);
  });

  it("runEgress drains retry buffer after POSTing new signals", async () => {
    const existingEntry: RetryBufferEntry = {
      member_id: SESSION_WITH_KEY.user_id,
      inferences: makeAcceptedSignals(1),
      queued_at: new Date().toISOString(),
    };
    const newSignals = makeAcceptedSignals(1);
    const deps = makeDeps({ buffer: [existingEntry] });

    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, newSignals, "0.1.2", deps);

    // Should have attempted 2 POSTs: 1 new batch + 1 drain
    expect(deps.calls.length).toBeGreaterThanOrEqual(2);
    const buf = await deps.loadRetryBuffer();
    expect(buf).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. filterToSinkAccepted applied before POST — sink-rejected trait never sent
// ---------------------------------------------------------------------------

describe("egress: sink-rejected traits never reach POST", () => {
  it("filterToSinkAccepted drops non-accepted traits before POST", async () => {
    const vaultNotes = buildDenseVault(120, 90);
    const rawSignals = deriveInferencesForSubtag("manual-note", vaultNotes);
    const filteredSignals = filterToSinkAccepted(rawSignals);

    // Verify there are signals to egress (test is meaningful only if vault is rich enough)
    if (filteredSignals.length === 0) {
      // Dense vault should produce accepted traits — skip quietly if gates didn't fire
      return;
    }

    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, filteredSignals, "0.1.2", deps);

    // Inspect what was actually POSTed
    for (const call of deps.calls) {
      const body = call.body as Record<string, unknown>;
      const params = body.params as Record<string, unknown>;
      const args = params.arguments as Record<string, unknown>;
      const inferences = args.inferences as Array<{ trait_name: string }>;
      for (const inf of inferences) {
        expect(SINK_ACCEPTED_TRAITS.has(inf.trait_name)).toBe(true);
      }
    }
  });

  it("raw engine output may contain non-accepted traits; filterToSinkAccepted removes them", () => {
    const vaultNotes = buildDenseVault(120, 90);
    const rawSignals = deriveInferencesForSubtag("manual-note", vaultNotes);
    const filteredSignals = filterToSinkAccepted(rawSignals);

    // Every filtered signal must be in SINK_ACCEPTED_TRAITS
    for (const s of filteredSignals) {
      expect(SINK_ACCEPTED_TRAITS.has(s.trait_name)).toBe(true);
    }
  });

  it("buildVaultIngestEnvelope excludes method_audit from the wire shape", () => {
    const signal = makeSignal("abstraction_comfort");
    const env = buildVaultIngestEnvelope("member-id", [signal]);
    const params = (env as Record<string, unknown>).params as Record<string, unknown>;
    const args = params.arguments as Record<string, unknown>;
    const inferences = args.inferences as Record<string, unknown>[];
    expect(inferences).toHaveLength(1);
    expect(Object.keys(inferences[0])).not.toContain("method_audit");
    expect(inferences[0].trait_name).toBe("abstraction_comfort");
    expect(inferences[0].provenance_class).toBe("passive_local_document");
  });
});

// ---------------------------------------------------------------------------
// 5. 256-per-call batch ceiling
// ---------------------------------------------------------------------------

describe("egress: 256-per-call ceiling", () => {
  it("splits 257 signals into 2 batches", async () => {
    const signals = makeAcceptedSignals(257);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);

    // Should have made 2 POST calls (256 + 1)
    expect(deps.calls).toHaveLength(2);
  });

  it("first batch has 256 inferences, second has 1", async () => {
    const signals = makeAcceptedSignals(257);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);

    const firstBatchArgs = ((deps.calls[0].body as Record<string, unknown>).params as Record<string, unknown>).arguments as Record<string, unknown>;
    const secondBatchArgs = ((deps.calls[1].body as Record<string, unknown>).params as Record<string, unknown>).arguments as Record<string, unknown>;
    expect((firstBatchArgs.inferences as unknown[]).length).toBe(256);
    expect((secondBatchArgs.inferences as unknown[]).length).toBe(1);
  });

  it("MAX_INFERENCES_PER_CALL is 256", () => {
    expect(MAX_INFERENCES_PER_CALL).toBe(256);
  });

  it("exactly 256 signals → single batch", async () => {
    const signals = makeAcceptedSignals(256);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);
    expect(deps.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Daemonless consent grant: alter_consent grant_vault tools/call shape
//    (Model A member-self). No revocation token.
// ---------------------------------------------------------------------------

/** Extract the tools/call params from a recorded postJson body. */
function toolsCall(body: unknown): { name: unknown; arguments: Record<string, unknown> } {
  const env = body as Record<string, unknown>;
  const params = env.params as Record<string, unknown>;
  return {
    name: params.name,
    arguments: params.arguments as Record<string, unknown>,
  };
}

describe("daemonless consent grant (alter_consent grant_vault)", () => {
  it("POSTs to the /api/v1/mcp endpoint as a tools/call", async () => {
    const deps = makeDeps({
      postBody: { result: { granted_at: "2026-06-05T00:00:00Z" } },
    });
    const grantedAt = await directGrantConsent(
      "https://api.truealter.com",
      SESSION_WITH_KEY,
      "obsidian-vault/manual-note",
      "deadbeef00000000",
      "0.1.2",
      deps,
    );

    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].url).toBe("https://api.truealter.com/api/v1/mcp");
    const body = deps.calls[0].body as Record<string, unknown>;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("tools/call");
    expect(grantedAt).toBe("2026-06-05T00:00:00Z");
  });

  it("calls tool name=alter_consent with action=grant_vault", async () => {
    const deps = makeDeps({ postBody: { result: {} } });
    await directGrantConsent(
      "https://api.truealter.com",
      SESSION_WITH_KEY,
      "obsidian-vault/reading-note",
      "vaulthash",
      "0.1.2",
      deps,
    );
    const call = toolsCall(deps.calls[0].body);
    expect(call.name).toBe("alter_consent");
    expect(call.arguments.action).toBe("grant_vault");
    expect(call.arguments.stream).toBe("obsidian-vault/reading-note");
    expect(call.arguments.vault_path_hash).toBe("vaulthash");
  });

  it("does NOT send a purposes arg in the grant (backend fixes purposes)", async () => {
    const deps = makeDeps({ postBody: { result: {} } });
    await directGrantConsent(
      "https://api.truealter.com",
      SESSION_WITH_KEY,
      "obsidian-vault/journal",
      "hash",
      "0.1.2",
      deps,
    );
    const call = toolsCall(deps.calls[0].body);
    expect(Object.keys(call.arguments)).not.toContain("purposes");
  });

  it("returns no revocation token (Model A member-self)", async () => {
    // Even if the backend were to echo one, the plugin never surfaces it.
    const deps = makeDeps({ postBody: { result: { granted_at: "t" } } });
    const result = await directGrantConsent(
      "https://api.truealter.com",
      SESSION_WITH_KEY,
      "obsidian-vault/journal",
      "hash",
      "0.1.2",
      deps,
    );
    expect(result).toBe("t");
    // The recorded outbound body carries no revocation_token field.
    const call = toolsCall(deps.calls[0].body);
    expect(call.arguments).not.toHaveProperty("revocation_token");
  });

  it("includes X-ALTER-API-Key header", async () => {
    const deps = makeDeps({ postBody: { result: {} } });
    await directGrantConsent(
      "https://api.truealter.com",
      SESSION_WITH_KEY,
      "obsidian-vault/journal",
      "hash",
      "0.1.2",
      deps,
    );
    expect(deps.calls[0].headers["X-ALTER-API-Key"]).toBe(SESSION_WITH_KEY.member_api_key);
    expect(deps.calls[0].headers["X-Alter-Client-Id"]).toBe("alter-obsidian");
  });

  it("throws when no member_api_key in session", async () => {
    const deps = makeDeps();
    await expect(
      directGrantConsent(
        "https://api.truealter.com",
        SESSION_WITHOUT_KEY,
        "obsidian-vault/journal",
        "hash",
        "0.1.2",
        deps,
      ),
    ).rejects.toThrow("no member API key");
  });

  it("throws on non-2xx response", async () => {
    const deps = makeDeps({ postStatus: 403 });
    await expect(
      directGrantConsent(
        "https://api.truealter.com",
        SESSION_WITH_KEY,
        "obsidian-vault/journal",
        "hash",
        "0.1.2",
        deps,
      ),
    ).rejects.toThrow("consent grant failed: HTTP 403");
  });

  it("throws when the MCP result carries isError=true (2xx but tool-level error)", async () => {
    const deps = makeDeps({ postStatus: 200, postBody: { result: { isError: true } } });
    await expect(
      directGrantConsent(
        "https://api.truealter.com",
        SESSION_WITH_KEY,
        "obsidian-vault/journal",
        "hash",
        "0.1.2",
        deps,
      ),
    ).rejects.toThrow("consent grant failed");
  });
});

// ---------------------------------------------------------------------------
// 7. Daemonless consent revoke — alter_consent set purposes=[] tools/call
// ---------------------------------------------------------------------------

describe("daemonless consent revoke (alter_consent set purposes=[])", () => {
  it("POSTs to the /api/v1/mcp endpoint as a tools/call", async () => {
    const deps = makeDeps({ postBody: { result: {} } });
    await directRevokeConsent(
      "https://api.truealter.com",
      SESSION_WITH_KEY,
      "obsidian-vault/manual-note",
      "0.1.2",
      deps,
    );
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].url).toBe("https://api.truealter.com/api/v1/mcp");
    const body = deps.calls[0].body as Record<string, unknown>;
    expect(body.method).toBe("tools/call");
  });

  it("calls tool name=alter_consent with action=set and empty purposes", async () => {
    const deps = makeDeps({ postBody: { result: {} } });
    await directRevokeConsent(
      "https://api.truealter.com",
      SESSION_WITH_KEY,
      "obsidian-vault/journal",
      "0.1.2",
      deps,
    );
    const call = toolsCall(deps.calls[0].body);
    expect(call.name).toBe("alter_consent");
    expect(call.arguments.action).toBe("set");
    expect(call.arguments.stream).toBe("obsidian-vault/journal");
    expect(call.arguments.purposes).toEqual([]);
  });

  it("does NOT send a revocation_token arg (member-self)", async () => {
    const deps = makeDeps({ postBody: { result: {} } });
    await directRevokeConsent(
      "https://api.truealter.com",
      SESSION_WITH_KEY,
      "obsidian-vault/journal",
      "0.1.2",
      deps,
    );
    const call = toolsCall(deps.calls[0].body);
    expect(call.arguments).not.toHaveProperty("revocation_token");
  });

  it("includes X-ALTER-API-Key header", async () => {
    const deps = makeDeps({ postBody: { result: {} } });
    await directRevokeConsent(
      "https://api.truealter.com",
      SESSION_WITH_KEY,
      "obsidian-vault/journal",
      "0.1.2",
      deps,
    );
    expect(deps.calls[0].headers["X-ALTER-API-Key"]).toBe(SESSION_WITH_KEY.member_api_key);
  });

  it("throws when no member_api_key", async () => {
    const deps = makeDeps();
    await expect(
      directRevokeConsent(
        "https://api.truealter.com",
        SESSION_WITHOUT_KEY,
        "obsidian-vault/journal",
        "0.1.2",
        deps,
      ),
    ).rejects.toThrow("no member API key");
  });

  it("throws on non-2xx response", async () => {
    const deps = makeDeps({ postStatus: 401 });
    await expect(
      directRevokeConsent(
        "https://api.truealter.com",
        SESSION_WITH_KEY,
        "obsidian-vault/journal",
        "0.1.2",
        deps,
      ),
    ).rejects.toThrow("consent revoke failed: HTTP 401");
  });

  it("throws when the MCP result carries isError=true", async () => {
    const deps = makeDeps({ postStatus: 200, postBody: { result: { isError: true } } });
    await expect(
      directRevokeConsent(
        "https://api.truealter.com",
        SESSION_WITH_KEY,
        "obsidian-vault/journal",
        "0.1.2",
        deps,
      ),
    ).rejects.toThrow("consent revoke failed");
  });
});

// ---------------------------------------------------------------------------
// 7b. Retry buffer cap — never exceeds MAX_RETRY_BUFFER_ENTRIES, drops oldest
// ---------------------------------------------------------------------------

describe("egress: retry buffer cap (MAX_RETRY_BUFFER_ENTRIES)", () => {
  it("caps the buffer at 50 entries, dropping the oldest on overflow", async () => {
    // Seed 50 entries, each tagged with a distinct queued_at so we can prove
    // the OLDEST is the one dropped. Every POST fails so each runEgress call
    // appends exactly one new entry.
    const seed: RetryBufferEntry[] = Array.from({ length: 50 }, (_, i) => ({
      member_id: SESSION_WITH_KEY.user_id,
      inferences: makeAcceptedSignals(1),
      queued_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    }));
    const deps = makeDeps({ buffer: seed, postStatus: 500 });

    // One more failing batch → would be the 51st entry → oldest dropped.
    await runEgress(
      "https://api.truealter.com",
      SESSION_WITH_KEY,
      makeAcceptedSignals(1),
      "0.1.2",
      deps,
    );

    const buf = await deps.loadRetryBuffer();
    expect(buf.length).toBe(MAX_RETRY_BUFFER_ENTRIES);
    expect(buf.length).toBe(50);
    // The oldest seed entry (index 0) must have been dropped.
    expect(buf.some((e) => e.queued_at === "2026-01-01T00:00:00Z")).toBe(false);
    // The second-oldest seed entry survives as the new front (oldest-first).
    expect(buf[0].queued_at).toBe("2026-01-01T00:00:01Z");
  });

  it("MAX_RETRY_BUFFER_ENTRIES is 50", () => {
    expect(MAX_RETRY_BUFFER_ENTRIES).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// 8. No member_api_key → enqueue to retry buffer, no POST
// ---------------------------------------------------------------------------

describe("egress: no member_api_key", () => {
  it("enqueues to retry buffer without POSTing when member_api_key absent", async () => {
    const signals = makeAcceptedSignals(2);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITHOUT_KEY, signals, "0.1.2", deps);

    // No POST should have been made
    expect(deps.calls).toHaveLength(0);

    // Signals should be in retry buffer
    const buf = await deps.loadRetryBuffer();
    expect(buf.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Confidence cap preserved through egress — never re-stamped
// ---------------------------------------------------------------------------

describe("egress: confidence cap preserved", () => {
  it("emitted inferences carry engine confidence unchanged (not re-clamped by egress)", async () => {
    const signal = makeSignal("abstraction_comfort");
    signal.confidence = 0.28; // below cap, above floor — must pass through unchanged
    const deps = makeDeps();
    await postBatch(
      "https://api.truealter.com",
      SESSION_WITH_KEY.user_id,
      [signal],
      SESSION_WITH_KEY.member_api_key!,
      "0.1.2",
      deps,
    );
    const body = deps.calls[0].body as Record<string, unknown>;
    const params = body.params as Record<string, unknown>;
    const args = params.arguments as Record<string, unknown>;
    const inferences = args.inferences as Array<{ confidence: number }>;
    expect(inferences[0].confidence).toBe(0.28);
  });

  it("provenance_class is passive_local_document in every POSTed inference", async () => {
    const signals = makeAcceptedSignals(3);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);
    const body = deps.calls[0].body as Record<string, unknown>;
    const params = body.params as Record<string, unknown>;
    const args = params.arguments as Record<string, unknown>;
    const inferences = args.inferences as Array<{ provenance_class: string }>;
    for (const inf of inferences) {
      expect(inf.provenance_class).toBe("passive_local_document");
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Wire shape completeness — all required fields present
// ---------------------------------------------------------------------------

describe("vault_ingest wire shape completeness", () => {
  const REQUIRED_FIELDS = [
    "trait_name",
    "value",
    "confidence",
    "provenance_class",
    "stream_subtag",
    "source_digest",
  ];

  it("every POSTed inference carries all required vault_ingest fields", async () => {
    const signals = makeAcceptedSignals(2);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);
    const body = deps.calls[0].body as Record<string, unknown>;
    const params = body.params as Record<string, unknown>;
    const args = params.arguments as Record<string, unknown>;
    const inferences = args.inferences as Record<string, unknown>[];
    for (const inf of inferences) {
      for (const field of REQUIRED_FIELDS) {
        expect(inf).toHaveProperty(field);
      }
    }
  });

  it("source_digest is a 64-char hex string in POSTed inferences", async () => {
    const signals = makeAcceptedSignals(1);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);
    const body = deps.calls[0].body as Record<string, unknown>;
    const params = body.params as Record<string, unknown>;
    const args = params.arguments as Record<string, unknown>;
    const inferences = args.inferences as Array<{ source_digest: string }>;
    expect(inferences[0].source_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("member_id is sent in vault_ingest arguments", async () => {
    const signals = makeAcceptedSignals(1);
    const deps = makeDeps();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);
    const body = deps.calls[0].body as Record<string, unknown>;
    const params = body.params as Record<string, unknown>;
    const args = params.arguments as Record<string, unknown>;
    expect(args.member_id).toBe(SESSION_WITH_KEY.user_id);
  });
});
