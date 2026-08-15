/**
 * main-build-egress-deps.test.ts
 *
 * Regression guard: buildEgressDeps() MUST include a defined appendMethodAuditRow
 * that routes to AlterFolder.appendMethodAudit (the production provenance wire).
 *
 * This test exists to prevent the gap that existed before this commit: the
 * appendMethodAuditRow dep was only wired in tests but not in production's
 * buildEgressDeps(), leaving the `if (deps.appendMethodAuditRow)` guard at
 * vault-egress.ts always FALSE in production (zero ledger rows written).
 *
 * The plugin class cannot call onload() here (it fires network I/O), so we
 * subclass minimally — exactly as main-floor-gate.test.ts does — override only
 * what's needed to prevent network calls, then call buildEgressDeps() directly.
 */

import { describe, expect, it, vi } from "vitest";
import AlterPlugin from "../src/main";
import { AlterFolder } from "../src/alter-folder";
import type { MethodAuditLedgerRow } from "../src/alter-folder";

// ---------------------------------------------------------------------------
// Minimal plugin subclass (mirrors TestPlugin in main-floor-gate.test.ts)
// ---------------------------------------------------------------------------

class DepTestPlugin extends AlterPlugin {
  private cacheStore: unknown = null;

  constructor() {
    const app: any = {
      vault: {
        adapter: {
          basePath: "/test/vault/dep-test",
          exists: async () => false,
          read: async () => "",
          write: async () => undefined,
        },
        getName: () => "dep-test-vault",
        getAbstractFileByPath: () => null,
      },
      workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
    };
    const manifest: any = { version: "0.1.0", id: "alter-obsidian-plugin" };
    super(app, manifest);
  }

  // Override loadData/saveData (Obsidian-managed) with in-memory store.
  async loadData(): Promise<any> { return this.cacheStore; }
  async saveData(d: any): Promise<void> { this.cacheStore = d; }

  // Override registration surfaces to no-ops so onload() is never needed.
  addRibbonIcon = ((_a: string, _b: string, _c: any): any => ({})) as any;
  addStatusBarItem = ((): any => ({
    addClass: () => {}, removeClass: () => {}, setText: () => {},
  })) as any;
  addCommand = ((_c: any): any => {}) as any;
  addSettingTab = ((_t: any): void => {}) as any;

  protected override apiBase(): string { return "https://api.test"; }

  /** Expose folder for test assertions. */
  get testFolder() { return (this as any).folder; }

  /** Manually initialise the folder so buildEgressDeps() has it. */
  initFolder() {
    // AlterFolder is constructed in onload(); we trigger it directly here
    // without running onload() (which fires network + timer setup).
    (this as any).folder = new AlterFolder(
      this.app.vault.adapter as any,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildEgressDeps(): production provenance wire (regression guard)", () => {
  it("includes a defined appendMethodAuditRow when folder is initialised", () => {
    const plugin = new DepTestPlugin();
    plugin.initFolder();

    const deps = plugin.buildEgressDeps();

    expect(deps.appendMethodAuditRow).toBeDefined();
    expect(typeof deps.appendMethodAuditRow).toBe("function");
  });

  it("appendMethodAuditRow delegates to AlterFolder.appendMethodAudit", async () => {
    const plugin = new DepTestPlugin();
    plugin.initFolder();

    // Spy on the real AlterFolder instance's appendMethodAudit.
    const auditSpy = vi.spyOn(plugin.testFolder, "appendMethodAudit")
      .mockResolvedValue(undefined);

    const deps = plugin.buildEgressDeps();
    expect(deps.appendMethodAuditRow).toBeDefined();

    const row: MethodAuditLedgerRow = {
      source_digest: "a".repeat(64),
      trait_name: "openness",
      stream_subtag: "obsidian-vault/manual-note",
      method_audit: {
        observables: { test_obs: 0.7 },
        weighted_raw: 0.7,
        transform: "sigmoid",
        calibration_band: [0, 1],
      },
      recorded_at: new Date().toISOString(),
    };

    await deps.appendMethodAuditRow!(row);

    expect(auditSpy).toHaveBeenCalledOnce();
    expect(auditSpy).toHaveBeenCalledWith(row);
  });

  it("appendMethodAuditRow no-ops gracefully when folder is undefined", async () => {
    // Mirrors the `if (!this.folder) return` house idiom: if AlterFolder
    // hasn't been initialised (pre-onload), the dep must not throw.
    const plugin = new DepTestPlugin();
    // folder is undefined — do NOT call initFolder()

    const deps = plugin.buildEgressDeps();
    expect(deps.appendMethodAuditRow).toBeDefined();

    // Should complete without error (no-op).
    const row: MethodAuditLedgerRow = {
      source_digest: "b".repeat(64),
      trait_name: "conscientiousness",
      stream_subtag: "obsidian-vault/manual-note",
      method_audit: {
        observables: { test_obs: 0.5 },
        weighted_raw: 0.5,
        transform: "sigmoid",
        calibration_band: [0, 1],
      },
      recorded_at: new Date().toISOString(),
    };

    await expect(deps.appendMethodAuditRow!(row)).resolves.toBeUndefined();
  });
});
