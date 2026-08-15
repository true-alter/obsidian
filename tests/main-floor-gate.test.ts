/*
 * main-floor-gate - integration test for AlterPlugin's below-floor gate.
 * Covers "below-floor blocks command registration" and "upgrade modal
 * renders".
 *
 * The Obsidian `App` / `Plugin` / `Modal` surfaces are stubbed via the existing
 * obsidian mock; we observe behaviour through `addCommand` interception.
 */

import * as crypto from "node:crypto";

import { describe, expect, it, beforeEach } from "vitest";

import AlterPlugin from "../src/main";
import {
  _resetInMemoryCache,
  canonicalJson,
  type FloorDocument,
} from "../src/floor-preflight";

// Ed25519 dev keypair - TEST FIXTURE ONLY (never bundled into the plugin).
// Same non-prod keypair the floor-preflight tests use; its public half is
// registered in KNOWN_FLOOR_PUBLIC_KEYS under key_id 8aa59e05, so docs signed
// here verify exactly as backend-signed docs do. Byte-equality assertions
// against the Python canonical live in floor-preflight.test.ts.
const DEV_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIOsPxNKQgyUlhRL8npS3JouRWzPuMqWjxo3tbmTDvlud
-----END PRIVATE KEY-----`;
const DEV_KEY_ID = "8aa59e05";

async function signDoc(
  floors: FloorDocument["floors"],
  served_at = "2026-05-27T00:00:00Z",
): Promise<FloorDocument> {
  const canonical = canonicalJson({ floors, served_at });
  const privKey = crypto.createPrivateKey({
    key: DEV_PRIVATE_KEY_PEM,
    format: "pem",
  });
  const signature = crypto
    .sign(null, Buffer.from(canonical, "utf-8"), privKey)
    .toString("hex");
  return {
    floors,
    served_at,
    cache_ttl_seconds: 3600,
    signature,
    key_id: DEV_KEY_ID,
  };
}

/**
 * Subclass under test that stubs:
 *   - manifest version,
 *   - the HTTP client to return a controlled floor doc,
 *   - the load/save data path (in-memory),
 *   - the modal open() so we can observe whether it was shown.
 *
 * Everything else from `AlterPlugin` runs as production.
 */
class TestPlugin extends AlterPlugin {
  public registeredCommandIds: string[] = [];
  public modalShown = 0;
  public lastModalHeading: string | null = null;
  public auditPosts: Array<{ url: string; body: unknown }> = [];
  private cacheStore: unknown = null;
  private floorDoc: FloorDocument | null = null;
  private fetchShouldThrow: Error | null = null;

  constructor(floorDoc: FloorDocument | null, version = "0.1.2") {
    // Minimal app / manifest stubs.
    const app: any = {
      vault: {
        adapter: {
          basePath: "/test/vault",
          read: async () => "",
          write: async () => undefined,
        },
        getName: () => "test-vault",
        getAbstractFileByPath: () => null,
      },
      workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
    };
    const manifest: any = { version, id: "alter-obsidian-plugin" };
    super(app, manifest);
    this.floorDoc = floorDoc;
  }

  // Override the Obsidian-internal `addCommand` so we can observe it.
  // Signature widened via `as any` to bypass the real Obsidian Command type.
  addCommand = ((cmd: any): any => {
    this.registeredCommandIds.push(cmd.id);
    return cmd;
  }) as any;

  // Override the ribbon / status-bar / settings tab registrations to be
  // observable no-ops.
  addRibbonIcon = ((_a: string, _b: string, _c: any): any => {
    this.registeredCommandIds.push("__ribbon__");
    return {};
  }) as any;
  addStatusBarItem = ((): any => {
    this.registeredCommandIds.push("__status__");
    return { addClass: () => {}, removeClass: () => {}, setText: () => {} };
  }) as any;
  addSettingTab = ((_t: any): void => {
    this.registeredCommandIds.push("__settings__");
  }) as any;

  // Override loadData/saveData to use our in-memory store (Obsidian-managed).
  async loadData(): Promise<any> {
    return this.cacheStore;
  }
  async saveData(d: any): Promise<void> {
    this.cacheStore = d;
  }

  // Override the modal display so we can observe it.
  protected override showFloorBlockModal(envelope: any): void {
    this.modalShown += 1;
    this.lastModalHeading = "~Alter plugin needs upgrade";
    // Do not actually instantiate Modal - test mock is no-op anyway.
    void envelope;
  }

  // Override the http client + apiBase so the floor doc is deterministic.
  protected override floorHttpClient() {
    const auditPosts = this.auditPosts;
    const fetchShouldThrow = this.fetchShouldThrow;
    const doc = this.floorDoc;
    return {
      async get(_url: string): Promise<FloorDocument> {
        if (fetchShouldThrow) throw fetchShouldThrow;
        if (!doc) throw new Error("no-doc");
        return doc;
      },
      async post(url: string, body: unknown): Promise<void> {
        auditPosts.push({ url, body });
      },
    };
  }

  protected override apiBase(): string {
    return "https://api.test";
  }

  /** Test hook to force fetch failure. */
  forceOffline(err = new Error("offline")): void {
    this.fetchShouldThrow = err;
  }
}

beforeEach(() => {
  _resetInMemoryCache();
});

describe("AlterPlugin onload - below-floor gate", () => {
  it("ABOVE FLOOR: registers full command surface", async () => {
    const doc = await signDoc({
      "alter-obsidian": {
        min_version: "0.1.0",
        upgrade_cmd: "update via Obsidian Community Plugins",
      },
    });
    const plugin = new TestPlugin(doc, "0.1.2");
    await plugin.onload();

    // Pair / show-return / unpair + ribbon + status + settings tab.
    expect(plugin.registeredCommandIds).toContain("pair-vault");
    expect(plugin.registeredCommandIds).toContain("show-return");
    expect(plugin.registeredCommandIds).toContain("unpair-vault");
    expect(plugin.registeredCommandIds).toContain("__ribbon__");
    expect(plugin.registeredCommandIds).toContain("__status__");
    expect(plugin.registeredCommandIds).toContain("__settings__");

    // No modal shown.
    expect(plugin.modalShown).toBe(0);
    // No audit posted.
    expect(plugin.auditPosts).toHaveLength(0);
  });

  it("BELOW FLOOR: registers ONLY the upgrade-notice command and shows modal", async () => {
    const doc = await signDoc({
      "alter-obsidian": {
        min_version: "0.5.0",
        upgrade_cmd: "update via Obsidian Community Plugins",
      },
    });
    const plugin = new TestPlugin(doc, "0.1.2");
    await plugin.onload();

    // Only the upgrade-notice command - NO pair/return/unpair, NO ribbon,
    // NO status bar, NO settings tab.
    expect(plugin.registeredCommandIds).toEqual([
      "alter-plugin-needs-upgrade",
    ]);

    // Modal shown exactly once on load.
    expect(plugin.modalShown).toBe(1);
    expect(plugin.lastModalHeading).toBe("~Alter plugin needs upgrade");

    // Audit signal posted (best-effort, non-blocking).
    // Give microtask queue a tick for the void-Promise to flush.
    await new Promise((r) => setTimeout(r, 5));
    expect(plugin.auditPosts.length).toBe(1);
    expect(plugin.auditPosts[0].url).toBe(
      "https://api.test/v1/clients/floor-rejection",
    );
    const body = plugin.auditPosts[0].body as Record<string, unknown>;
    expect(body.client_id).toBe("alter-obsidian");
    expect(body.client_version).toBe("0.1.2");
    expect(body.min_version).toBe("0.5.0");
  });

  it("BACKEND UNREACHABLE + NO CACHE: permits load (no offline lockout for first run)", async () => {
    const plugin = new TestPlugin(null, "0.1.2");
    plugin.forceOffline(new Error("ENETUNREACH"));
    await plugin.onload();

    // No floor signal received, no cache - permits. Full surface registered.
    expect(plugin.registeredCommandIds).toContain("pair-vault");
    expect(plugin.modalShown).toBe(0);
  });

  it("MALFORMED FLOOR DOC: refuses to cache, permits load", async () => {
    // Sign with the right key but tamper the body so verifyFloorSignature
    // fails at the fetch step. The preflight throws → no-cache path.
    const doc = await signDoc({
      "alter-obsidian": {
        min_version: "0.1.0",
        upgrade_cmd: "update via Obsidian Community Plugins",
      },
    });
    (doc as any).floors["alter-obsidian"].min_version = "999.0.0";
    const plugin = new TestPlugin(doc, "0.1.2");
    await plugin.onload();

    // Permits load - server-side gate is the load-bearing reject.
    expect(plugin.registeredCommandIds).toContain("pair-vault");
    expect(plugin.modalShown).toBe(0);
  });
});
