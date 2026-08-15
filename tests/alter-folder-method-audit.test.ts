/**
 * alter-folder-method-audit.test.ts
 *
 * Tests for AlterFolder.appendMethodAudit, the local derivation-provenance
 * ledger (METHOD-AUDIT.ndjson). Mirrors the style of alter-folder.test.ts.
 *
 * Coverage:
 *   1. First append creates METHOD-AUDIT.ndjson with a valid ndjson row
 *   2. Row carries source_digest, method_audit, trait_name, stream_subtag, recorded_at
 *   3. Append-only: second append of a DIFFERENT source_digest adds a second row
 *   4. Idempotent: second append of the SAME source_digest is a no-op (no duplicate row)
 *   5. PATHS.METHOD_AUDIT_LEDGER_PATH is exported and correct
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  AlterFolder,
  MethodAuditLedgerRow,
  PATHS,
  VaultAdapter,
} from "../src/alter-folder";
import type { MethodAudit } from "../src/vault-trait-engine/types";

// ---------------------------------------------------------------------------
// In-memory adapter (mirrors alter-folder.test.ts)
// ---------------------------------------------------------------------------

class InMemoryAdapter implements VaultAdapter {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || this.dirs.has(p);
  }
  async mkdir(p: string): Promise<void> {
    this.dirs.add(p);
  }
  async read(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async write(p: string, data: string): Promise<void> {
    this.files.set(p, data);
  }
  // No `append` override — exercises the read-append-write fallback path
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUDIT_A: MethodAudit = {
  observables: { word_count_per_note: 0.72, revisions_per_note: 0.45 },
  weighted_raw: 0.61,
  transform: "sigmoid",
  calibration_band: [0, 1],
};

const AUDIT_B: MethodAudit = {
  observables: { link_density: 0.30 },
  weighted_raw: 0.30,
  transform: "sigmoid",
  calibration_band: [0.1, 0.9],
};

function makeRow(
  source_digest: string,
  method_audit: MethodAudit = AUDIT_A,
  trait_name = "reflective_orientation",
  stream_subtag = "obsidian-vault/manual-note",
  recorded_at = "2026-06-05T00:00:00.000Z",
): MethodAuditLedgerRow {
  return { source_digest, trait_name, stream_subtag, method_audit, recorded_at };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AlterFolder.appendMethodAudit", () => {
  let adapter: InMemoryAdapter;
  let folder: AlterFolder;

  beforeEach(() => {
    adapter = new InMemoryAdapter();
    folder = new AlterFolder(adapter);
  });

  // 1. First append creates the file
  it("creates METHOD-AUDIT.ndjson on the first append", async () => {
    await folder.appendMethodAudit(makeRow("a".repeat(64)));
    expect(adapter.files.has(PATHS.METHOD_AUDIT_LEDGER_PATH)).toBe(true);
  });

  // 2. Row shape: all required fields present, parseable ndjson
  it("row carries source_digest, method_audit, trait_name, stream_subtag, recorded_at", async () => {
    const digest = "b".repeat(64);
    const row = makeRow(digest);
    await folder.appendMethodAudit(row);

    const raw = adapter.files.get(PATHS.METHOD_AUDIT_LEDGER_PATH)!;
    const parsed = JSON.parse(raw.trim().split("\n")[0]) as MethodAuditLedgerRow;

    expect(parsed.source_digest).toBe(digest);
    expect(parsed.trait_name).toBe("reflective_orientation");
    expect(parsed.stream_subtag).toBe("obsidian-vault/manual-note");
    expect(parsed.recorded_at).toBe("2026-06-05T00:00:00.000Z");
    expect(parsed.method_audit.transform).toBe("sigmoid");
    expect(parsed.method_audit.weighted_raw).toBe(0.61);
    expect(parsed.method_audit.observables).toEqual(AUDIT_A.observables);
    expect(parsed.method_audit.calibration_band).toEqual([0, 1]);
  });

  // 3. Append-only: different source_digest → second row
  it("appends a second row for a different source_digest", async () => {
    await folder.appendMethodAudit(makeRow("c".repeat(64), AUDIT_A, "reflective_orientation"));
    await folder.appendMethodAudit(makeRow("d".repeat(64), AUDIT_B, "systems_thinking"));

    const raw = adapter.files.get(PATHS.METHOD_AUDIT_LEDGER_PATH)!;
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]) as MethodAuditLedgerRow;
    const second = JSON.parse(lines[1]) as MethodAuditLedgerRow;
    expect(first.source_digest).toBe("c".repeat(64));
    expect(second.source_digest).toBe("d".repeat(64));
    expect(second.trait_name).toBe("systems_thinking");
  });

  // 4. Idempotent: same source_digest twice → still only one row
  it("does not duplicate a row when the same source_digest is appended twice", async () => {
    const digest = "e".repeat(64);
    await folder.appendMethodAudit(makeRow(digest));
    await folder.appendMethodAudit(makeRow(digest)); // second call — must be no-op

    const raw = adapter.files.get(PATHS.METHOD_AUDIT_LEDGER_PATH)!;
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  // 5. PATHS export is correct
  it("PATHS.METHOD_AUDIT_LEDGER_PATH is ~Alter/METHOD-AUDIT.ndjson", () => {
    expect(PATHS.METHOD_AUDIT_LEDGER_PATH).toBe("~Alter/METHOD-AUDIT.ndjson");
  });
});
