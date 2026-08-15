import { describe, it, expect, vi } from "vitest";
import { AlterFolder, VaultAdapter } from "../src/alter-folder";
import {
  DEFAULT_PURPOSES,
  PURPOSE_LABELS,
  PairingCeremony,
  CeremonyDeps,
} from "../src/pairing-ceremony";
import type { VaultSubtag } from "../src/types";

class InMemoryAdapter implements VaultAdapter {
  files = new Map<string, string>();
  dirs = new Set<string>();
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async mkdir(p: string) {
    this.dirs.add(p);
  }
  async read(p: string) {
    return this.files.get(p) ?? "";
  }
  async write(p: string, data: string) {
    this.files.set(p, data);
  }
}

function makeDeps(overrides: Partial<CeremonyDeps> = {}): CeremonyDeps {
  const adapter = new InMemoryAdapter();
  const folder = new AlterFolder(adapter);
  // Default grantConsent: member-self, returns a granted_at, no token (Model A).
  const grantConsent = vi.fn(
    async (_stream: string, _vaultPathHash: string) => "2026-04-25T12:00:00Z",
  );
  return {
    folder,
    grantConsent,
    readSession: async () => ({
      handle: "~example",
      user_id: "m-example",
      logged_in_at: "2026-04-25T11:00:00Z",
      jwt_expires_at: "2026-04-26T11:00:00Z",
    }),
    vaultPathHash: async () => "vault-hash-abc",
    notify: vi.fn(),
    confirm: async () => true,
    subtags: ["journal" as VaultSubtag],
    ...overrides,
  };
}

describe("DEFAULT_PURPOSES - backend ledger reconciliation", () => {
  /*
   * These four strings MUST equal the backend consent ledger's accepted
   * purpose set. Earlier scaffold values would have caused an error on
   * every pairing. If the backend whitelist changes, this test forces the
   * plugin to follow.
   */
  it("matches the four canonical ledger purposes", () => {
    expect(new Set(DEFAULT_PURPOSES)).toEqual(
      new Set([
        "mirror_reflection",
        "identity_income",
        "search_amplification",
        "side_quest_nudge",
      ]),
    );
  });

  it("provides human-friendly labels for each purpose", () => {
    for (const p of DEFAULT_PURPOSES) {
      expect(PURPOSE_LABELS[p]).toBeTypeOf("string");
      expect(PURPOSE_LABELS[p]!.length).toBeGreaterThan(0);
    }
  });
});

describe("PairingCeremony", () => {
  it("walks unpaired -> paired on the happy path (single subtag)", async () => {
    const deps = makeDeps();
    const ceremony = new PairingCeremony(deps);
    const result = await ceremony.pair();
    expect(result.state).toBe("paired");
    expect(result.handle).toBe("~example");
    expect(result.grants).toHaveLength(1);
    expect(result.grants![0].subtag).toBe("journal");
    expect(result.grants![0].stream).toBe("obsidian-vault/journal");
    expect(result.grants![0].granted_at).toBe("2026-04-25T12:00:00Z");
    expect(result.vaultPathHash).toBe("vault-hash-abc");
    // No revocation token is ever surfaced on the grant record (Model A).
    expect(result.grants![0]).not.toHaveProperty("revocation_token_hash");
    // The member-self grant is invoked once for the single subtag.
    expect((deps.grantConsent as any).mock.calls).toHaveLength(1);
    expect((deps.grantConsent as any).mock.calls[0][0]).toBe(
      "obsidian-vault/journal",
    );
    expect((deps.grantConsent as any).mock.calls[0][1]).toBe("vault-hash-abc");
  });

  it("grants one member-self consent per subtag with its canonical stream", async () => {
    const deps = makeDeps({
      subtags: ["journal", "manual-note", "daily"] as VaultSubtag[],
    });
    const ceremony = new PairingCeremony(deps);
    const result = await ceremony.pair();
    expect(result.state).toBe("paired");
    expect(result.grants).toHaveLength(3);
    expect(deps.grantConsent).toHaveBeenCalledTimes(3);
    // Each grant carries its own canonical stream tag.
    const streams = result.grants!.map((g) => g.stream);
    expect(streams).toEqual([
      "obsidian-vault/journal",
      "obsidian-vault/manual-note",
      "obsidian-vault/daily",
    ]);
    // The grant is called per-subtag with the canonical stream.
    const grantedStreams = (deps.grantConsent as any).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(grantedStreams).toEqual([
      "obsidian-vault/journal",
      "obsidian-vault/manual-note",
      "obsidian-vault/daily",
    ]);
  });

  it("returns to unpaired (not failed) on user cancel", async () => {
    const deps = makeDeps({ confirm: async () => false });
    const ceremony = new PairingCeremony(deps);
    const result = await ceremony.pair();
    expect(result.state).toBe("unpaired");
    expect(deps.grantConsent).not.toHaveBeenCalled();
  });

  it("fails if no session is available", async () => {
    const deps = makeDeps({ readSession: async () => null });
    const ceremony = new PairingCeremony(deps);
    const result = await ceremony.pair();
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/alter login/);
  });

  it("fails if the consent grant is rejected", async () => {
    const deps = makeDeps({
      grantConsent: vi.fn(async () => {
        throw new Error("denied");
      }),
    });
    const ceremony = new PairingCeremony(deps);
    const result = await ceremony.pair();
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/denied/);
  });

  it("fails when no subtags are selected", async () => {
    const deps = makeDeps({ subtags: [] });
    const ceremony = new PairingCeremony(deps);
    const result = await ceremony.pair();
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/subtag/);
  });

  it("writes PAIRING.md with the granted subtags and no token (member-self)", async () => {
    const adapter = new InMemoryAdapter();
    const folder = new AlterFolder(adapter);
    const deps = makeDeps({
      folder,
      subtags: ["journal", "manual-note"] as VaultSubtag[],
    });
    const ceremony = new PairingCeremony(deps);
    await ceremony.pair();
    const pairing = adapter.files.get("~Alter/PAIRING.md")!;
    expect(pairing).toContain("handle: ~example");
    expect(pairing).toContain("obsidian-vault/journal");
    expect(pairing).toContain("obsidian-vault/manual-note");
    // No revocation token machinery is persisted.
    expect(pairing).not.toContain("revocation_token");
    expect(pairing).not.toContain("token_hash");
  });
});
