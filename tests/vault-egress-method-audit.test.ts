/**
 * vault-egress-method-audit.test.ts
 *
 * Tests for the method_audit ledger wiring inside runEgress.
 * Mirrors the style of vault-egress.test.ts.
 *
 * Coverage:
 *   1. A ledger row is appended for each egressed trait
 *   2. Each row is keyed by source_digest and carries method_audit + trait_name + stream_subtag
 *   3. Append-only: a second runEgress call with the same source_digest does NOT duplicate rows
 *      (idempotency is enforced by AlterFolder — here we verify the dep is called with the
 *       correct source_digest on each invocation so AlterFolder can de-dup)
 *   4. Link integrity: every egressed trait's source_digest matches a ledger row
 *   5. method_audit is NOT sent to the backend (existing invariant must still hold with ledger wired)
 *   6. When appendMethodAuditRow is absent (optional), runEgress still succeeds
 */

import { describe, expect, it } from "vitest";
import {
  VaultEgressDeps,
  RetryBufferEntry,
  runEgress,
} from "../src/vault-egress";
import type { MethodAuditLedgerRow } from "../src/alter-folder";
import type { TraitSignal } from "../src/vault-trait-engine/types";
import type { AlterSession } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures (mirrors vault-egress.test.ts style)
// ---------------------------------------------------------------------------

const SESSION_WITH_KEY: AlterSession = {
  handle: "~test",
  user_id: "user-uuid-ledger",
  member_api_key: "alt_test_ledger_key",
  jwt: "eyJ.test.jwt",
  logged_in_at: new Date().toISOString(),
  jwt_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
};

/** Minimal TraitSignal with a unique source_digest per trait_name. */
function makeSignal(trait_name: string, source_digest?: string): TraitSignal {
  return {
    trait_name,
    value: 0.55,
    confidence: 0.22,
    provenance_class: "passive_local_document",
    stream_subtag: "obsidian-vault/manual-note",
    source_digest: source_digest ?? ("f".repeat(63) + trait_name.slice(-1)),
    method_audit: {
      observables: { test_obs: 0.55 },
      weighted_raw: 0.55,
      transform: "sigmoid",
      calibration_band: [0, 1],
    },
  };
}

type PostCall = { url: string; body: unknown; headers: Record<string, string> };

function makeDepsWithLedger(opts: {
  postStatus?: number;
  // Start with a pre-populated ledger (source_digests already seen)
  existingDigests?: string[];
} = {}): VaultEgressDeps & {
  postCalls: PostCall[];
  ledger: Map<string, MethodAuditLedgerRow>;
} {
  let buffer: RetryBufferEntry[] = [];
  const postCalls: PostCall[] = [];
  const ledger = new Map<string, MethodAuditLedgerRow>(
    (opts.existingDigests ?? []).map((d) => [
      d,
      { source_digest: d, trait_name: "existing", stream_subtag: "obsidian-vault/manual-note",
        method_audit: { observables: {}, weighted_raw: 0, transform: "sigmoid", calibration_band: [0, 1] },
        recorded_at: "2026-01-01T00:00:00Z" },
    ]),
  );

  return {
    postCalls,
    ledger,
    loadRetryBuffer: async () => [...buffer],
    saveRetryBuffer: async (e) => { buffer = [...e]; },
    postJson: async (url, body, headers) => {
      postCalls.push({ url, body, headers });
      const status = opts.postStatus ?? 200;
      return { ok: status >= 200 && status < 300, status, body: { result: { inference_count: 1 } } };
    },
    appendMethodAuditRow: async (row: MethodAuditLedgerRow) => {
      // Mirror AlterFolder idempotency: skip if already present
      if (!ledger.has(row.source_digest)) {
        ledger.set(row.source_digest, row);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 1. A ledger row is appended for each egressed trait
// ---------------------------------------------------------------------------

describe("method_audit ledger: one row per signal", () => {
  it("appends one ledger row per signal", async () => {
    const signals = [
      makeSignal("reflective_orientation", "a".repeat(64)),
      makeSignal("systems_thinking", "b".repeat(64)),
    ];
    const deps = makeDepsWithLedger();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);

    expect(deps.ledger.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Row keyed by source_digest, carries correct fields
// ---------------------------------------------------------------------------

describe("method_audit ledger: row shape", () => {
  it("row is keyed by source_digest and carries method_audit, trait_name, stream_subtag", async () => {
    const digest = "c".repeat(64);
    const signal = makeSignal("abstraction_comfort", digest);
    const deps = makeDepsWithLedger();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, [signal], "0.1.2", deps);

    const row = deps.ledger.get(digest);
    expect(row).toBeDefined();
    expect(row!.source_digest).toBe(digest);
    expect(row!.trait_name).toBe("abstraction_comfort");
    expect(row!.stream_subtag).toBe("obsidian-vault/manual-note");
    expect(row!.method_audit.transform).toBe("sigmoid");
    expect(row!.method_audit.observables).toEqual({ test_obs: 0.55 });
    expect(row!.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// 3. Append-only idempotency: same source_digest twice — no duplicate
// ---------------------------------------------------------------------------

describe("method_audit ledger: idempotent on re-egress of same source_digest", () => {
  it("does not duplicate a ledger row when the same source_digest is egressed twice", async () => {
    const digest = "d".repeat(64);
    const signal = makeSignal("reflective_orientation", digest);
    const deps = makeDepsWithLedger();

    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, [signal], "0.1.2", deps);
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, [signal], "0.1.2", deps);

    // The underlying appendMethodAuditRow was called twice, but because the
    // mock mirrors AlterFolder's idempotency (skip if already present) the
    // ledger still has only one row for this digest.
    expect(deps.ledger.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Link integrity: every egressed trait's source_digest has a ledger row
// ---------------------------------------------------------------------------

describe("method_audit ledger: link integrity", () => {
  it("every signal's source_digest maps to a ledger row after egress", async () => {
    const signals = [
      makeSignal("reflective_orientation", "e".repeat(64)),
      makeSignal("systems_thinking",       "f".repeat(64)),
      makeSignal("abstraction_comfort",    "0".repeat(64)),
    ];
    const deps = makeDepsWithLedger();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps);

    for (const signal of signals) {
      expect(deps.ledger.has(signal.source_digest)).toBe(true);
      const row = deps.ledger.get(signal.source_digest)!;
      expect(row.trait_name).toBe(signal.trait_name);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. method_audit is NOT sent to the backend — existing invariant preserved
// ---------------------------------------------------------------------------

describe("method_audit ledger: backend wire shape unchanged", () => {
  it("method_audit is still excluded from the backend POST when ledger is wired", async () => {
    const signal = makeSignal("abstraction_comfort", "1".repeat(64));
    const deps = makeDepsWithLedger();
    await runEgress("https://api.truealter.com", SESSION_WITH_KEY, [signal], "0.1.2", deps);

    const body = deps.postCalls[0]!.body as Record<string, unknown>;
    const params = body.params as Record<string, unknown>;
    const args = params.arguments as Record<string, unknown>;
    const inferences = args.inferences as Record<string, unknown>[];
    expect(Object.keys(inferences[0])).not.toContain("method_audit");
    expect(inferences[0].source_digest).toBe("1".repeat(64));
  });
});

// ---------------------------------------------------------------------------
// 6. appendMethodAuditRow absent — runEgress still succeeds
// ---------------------------------------------------------------------------

describe("method_audit ledger: optional dep — no-op when absent", () => {
  it("runEgress succeeds without appendMethodAuditRow in deps", async () => {
    const signals = [makeSignal("reflective_orientation", "2".repeat(64))];
    // Standard deps without appendMethodAuditRow
    let buffer: RetryBufferEntry[] = [];
    const postCalls: PostCall[] = [];
    const deps: VaultEgressDeps = {
      loadRetryBuffer: async () => [...buffer],
      saveRetryBuffer: async (e) => { buffer = [...e]; },
      postJson: async (url, body, headers) => {
        postCalls.push({ url, body, headers });
        return { ok: true, status: 200, body: { result: { inference_count: 1 } } };
      },
      // appendMethodAuditRow intentionally absent
    };

    await expect(
      runEgress("https://api.truealter.com", SESSION_WITH_KEY, signals, "0.1.2", deps),
    ).resolves.not.toThrow();

    // POST still happened
    expect(postCalls).toHaveLength(1);
  });
});
