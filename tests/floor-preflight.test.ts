/*
 * floor-preflight: the plugin's minimum-version check.
 *
 * Coverage:
 *   (a) preflight happy path (above floor).
 *   (b) Ed25519 verify rejection - tampered floor doc.
 *   (c) below-floor produces canonical client_below_floor envelope.
 *   (d) upgrade modal renders with correct copy.
 *   (e) X-Alter-Client-* headers attached to backend calls.
 *   plus disk-cache survival + connectivity ladder coverage.
 */

import * as crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_ID,
  FLOOR_REJECTION_AUDIT_ENDPOINT,
  KNOWN_FLOOR_PUBLIC_KEYS,
  MIN_VERSION_ENDPOINT,
  _resetInMemoryCache,
  buildClientHeaders,
  canonicalJson,
  compareSemver,
  computeKeyId,
  emitFloorRejectionAudit,
  preflightFloor,
  verifyFloorSignature,
  type ClientBelowFloorEnvelope,
  type FloorDiskCacheEntry,
  type FloorDocument,
  type FloorHttpClient,
} from "../src/floor-preflight";

import {
  OBSIDIAN_UPGRADE_CMD,
  buildObsidianUpgradePrompt,
  summariseEnvelopeForNotice,
} from "../src/upgrade-prompt";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// Ed25519 keypair - TEST FIXTURE ONLY. The private key is in tests/ (never
// bundled into the shipped plugin) and is the SAME non-prod dev keypair the
// alter-cli verifier tests use, so a doc signed here verifies against the
// registered public key (key_id 8aa59e05) exactly as a backend-signed doc does.
const DEV_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgqw28dlniOuiTE1f4BxCPSEgMLaPtHsO8wN5RWEwEhE=
-----END PUBLIC KEY-----`;

const DEV_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIOsPxNKQgyUlhRL8npS3JouRWzPuMqWjxo3tbmTDvlud
-----END PRIVATE KEY-----`;

const DEV_KEY_ID = "8aa59e05";

// Prod public key (public half only) - registered in KNOWN_FLOOR_PUBLIC_KEYS.
const PROD_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARzvAWayDwHvZRfOZizGZe+/a7PF082WGhyMS3tx06H4=
-----END PUBLIC KEY-----`;
const PROD_KEY_ID = "640f7d9a";

async function signFloorDoc(
  floors: FloorDocument["floors"],
  served_at: string,
  opts?: { keyId?: string; ttl?: number },
): Promise<FloorDocument> {
  const keyId = opts?.keyId ?? DEV_KEY_ID;
  const ttl = opts?.ttl ?? 3600;
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
    cache_ttl_seconds: ttl,
    signature,
    key_id: keyId,
  };
}

/** Build a floor doc with a single `alter-obsidian` entry at the given min. */
function obsidianFloorDoc(
  minVersion: string,
  served_at = "2026-05-27T00:00:00Z",
): Promise<FloorDocument> {
  return signFloorDoc(
    {
      "alter-obsidian": {
        min_version: minVersion,
        upgrade_cmd: OBSIDIAN_UPGRADE_CMD,
      },
    },
    served_at,
  );
}

interface MockHttp extends FloorHttpClient {
  getCalls: string[];
  postCalls: Array<{
    url: string;
    body: unknown;
    headers: Record<string, string>;
  }>;
}

function mockHttp(
  responseDoc: FloorDocument | null,
  opts?: { throwOnGet?: Error; throwOnPost?: Error },
): MockHttp {
  const getCalls: string[] = [];
  const postCalls: MockHttp["postCalls"] = [];
  return {
    getCalls,
    postCalls,
    async get(url: string): Promise<FloorDocument> {
      getCalls.push(url);
      if (opts?.throwOnGet) throw opts.throwOnGet;
      if (!responseDoc) throw new Error("no-response");
      return responseDoc;
    },
    async post(
      url: string,
      body: unknown,
      headers: Record<string, string>,
    ): Promise<void> {
      postCalls.push({ url, body, headers });
      if (opts?.throwOnPost) throw opts.throwOnPost;
    },
  };
}

function memCache(): {
  load: () => Promise<FloorDiskCacheEntry | null>;
  save: (e: FloorDiskCacheEntry) => Promise<void>;
  current: () => FloorDiskCacheEntry | null;
} {
  let entry: FloorDiskCacheEntry | null = null;
  return {
    load: async () => entry,
    save: async (e) => {
      entry = e;
    },
    current: () => entry,
  };
}

// ---------------------------------------------------------------------------
// Reset module state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetInMemoryCache();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// (a) preflight happy path
// ---------------------------------------------------------------------------

describe("preflightFloor - happy path", () => {
  it("permits above-floor client and populates disk cache", async () => {
    const doc = await obsidianFloorDoc("0.1.0");
    const http = mockHttp(doc);
    const cache = memCache();
    const result = await preflightFloor({
      clientVersion: "0.1.2",
      apiBase: "https://api.truealter.com",
      deps: {
        loadCache: cache.load,
        saveCache: cache.save,
        http,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostic).toBe("above-floor");
    expect(result.envelope).toBeUndefined();
    expect(http.getCalls).toEqual([
      `https://api.truealter.com${MIN_VERSION_ENDPOINT}`,
    ]);
    // Disk cache populated.
    expect(cache.current()).not.toBeNull();
    expect(cache.current()!.doc.key_id).toBe(DEV_KEY_ID);
  });

  it("respects in-memory cache after first call (no second fetch)", async () => {
    const doc = await obsidianFloorDoc("0.1.0");
    const http = mockHttp(doc);
    const cache = memCache();
    const deps = { loadCache: cache.load, saveCache: cache.save, http };
    await preflightFloor({
      clientVersion: "0.1.2",
      apiBase: "https://api.truealter.com",
      deps,
    });
    await preflightFloor({
      clientVersion: "0.1.2",
      apiBase: "https://api.truealter.com",
      deps,
    });
    // Only one network call - second hit served from in-memory cache.
    expect(http.getCalls.length).toBe(1);
  });

  it("permits when no floor entry exists for this client_id", async () => {
    const doc = await signFloorDoc(
      { "some-other-client": { min_version: "9.9.9", upgrade_cmd: "x" } },
      "2026-05-27T00:00:00Z",
    );
    const http = mockHttp(doc);
    const cache = memCache();
    const result = await preflightFloor({
      clientVersion: "0.1.2",
      apiBase: "https://api.truealter.com",
      deps: { loadCache: cache.load, saveCache: cache.save, http },
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostic).toBe("no-floor-defined");
  });
});

// ---------------------------------------------------------------------------
// (b) Ed25519 verify rejection
// ---------------------------------------------------------------------------

describe("Ed25519 verification", () => {
  it("verifies a correctly-signed doc", async () => {
    const doc = await obsidianFloorDoc("0.1.0");
    expect(await verifyFloorSignature(doc)).toBe(true);
  });

  it("rejects a doc with a tampered floor value", async () => {
    const doc = await obsidianFloorDoc("0.1.0");
    // Tamper - swap min_version after signing.
    const tampered: FloorDocument = {
      ...doc,
      floors: {
        "alter-obsidian": {
          min_version: "0.0.1",
          upgrade_cmd: OBSIDIAN_UPGRADE_CMD,
        },
      },
    };
    expect(await verifyFloorSignature(tampered)).toBe(false);
  });

  it("rejects a doc signed with an unknown key_id", async () => {
    // Use a key_id the client does not know about.
    const doc = await signFloorDoc(
      {
        "alter-obsidian": {
          min_version: "0.1.0",
          upgrade_cmd: OBSIDIAN_UPGRADE_CMD,
        },
      },
      "2026-05-27T00:00:00Z",
      { keyId: "unknown1" },
    );
    expect(await verifyFloorSignature(doc)).toBe(false);
  });

  it("rejects a tampered doc at fetch time (preflight throws then permits via no-cache path)", async () => {
    const validDoc = await obsidianFloorDoc("0.1.0");
    const tampered: FloorDocument = {
      ...validDoc,
      floors: {
        "alter-obsidian": {
          min_version: "999.0.0",
          upgrade_cmd: OBSIDIAN_UPGRADE_CMD,
        },
      },
    };
    const http = mockHttp(tampered);
    const cache = memCache();
    const result = await preflightFloor({
      clientVersion: "0.1.2",
      apiBase: "https://api.truealter.com",
      deps: { loadCache: cache.load, saveCache: cache.save, http },
    });
    // No cache + signature invalid + no fallback - permits with warn.
    // (server-side gate is still load-bearing.)
    expect(result.ok).toBe(true);
    expect(result.diagnostic).toBe("no-cache-no-fetch-permit");
    expect(result.warn).toMatch(/signature-invalid/);
    // Tampered doc NOT cached.
    expect(cache.current()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Canonical byte-equality with the signer
// ---------------------------------------------------------------------------
//
// These tests pin this implementation byte-for-byte against the key ids and
// canonical JSON the signer produces. If any of them drift, the plugin will
// silently fail signature verification against real signed documents.

describe("canonical byte-equality", () => {
  it("computeKeyId(dev public key PEM) === '8aa59e05'", async () => {
    // key_id = first 8 hex of SHA-256(raw 32-byte Ed25519 public key), which is
    // the same derivation the signer runs.
    expect(await computeKeyId(DEV_PUBLIC_KEY_PEM)).toBe(DEV_KEY_ID);
  });

  it("computeKeyId(prod public key PEM) === '640f7d9a'", async () => {
    expect(await computeKeyId(PROD_PUBLIC_KEY_PEM)).toBe(PROD_KEY_ID);
  });

  it("computeKeyId empty key returns the canonical sentinel", async () => {
    // Mirrors Phase 1 floor_signing key_id sentinel => "00000000".
    expect(await computeKeyId("")).toBe("00000000");
  });

  it("every KNOWN_FLOOR_PUBLIC_KEYS entry re-derives to its map key", async () => {
    for (const [id, pem] of Object.entries(KNOWN_FLOOR_PUBLIC_KEYS)) {
      expect(await computeKeyId(pem)).toBe(id);
    }
  });

  it("canonicalJson sorts keys recursively + uses compact separators", () => {
    // Python: json.dumps(payload, sort_keys=True, separators=(",", ":"))
    const payload = {
      floors: {
        "alter-obsidian": {
          upgrade_cmd: "update via Obsidian Community Plugins",
          min_version: "0.1.0",
        },
      },
      served_at: "2026-05-27T00:00:00Z",
    };
    expect(canonicalJson(payload)).toBe(
      '{"floors":{"alter-obsidian":{"min_version":"0.1.0","upgrade_cmd":"update via Obsidian Community Plugins"}},"served_at":"2026-05-27T00:00:00Z"}',
    );
  });

  it("Ed25519 sign+verify round-trip over the canonical bytes", async () => {
    // A doc signed with the dev PRIVATE key over canonicalJson({floors,
    // served_at}) must verify against the dev PUBLIC key - the same bytes the
    // Python backend signs (sort_keys + compact separators, ensure_ascii=False).
    const floors = {
      "alter-obsidian": {
        min_version: "0.1.0",
        upgrade_cmd: "update via Obsidian Community Plugins",
      },
    };
    const served_at = "2026-05-27T00:00:00Z";
    const canonical = canonicalJson({ floors, served_at });
    const privKey = crypto.createPrivateKey({
      key: DEV_PRIVATE_KEY_PEM,
      format: "pem",
    });
    const signature = crypto
      .sign(null, Buffer.from(canonical, "utf-8"), privKey)
      .toString("hex");
    const doc: FloorDocument = {
      floors,
      served_at,
      cache_ttl_seconds: 3600,
      signature,
      key_id: DEV_KEY_ID,
    };
    expect(
      await verifyFloorSignature(doc, { [DEV_KEY_ID]: DEV_PUBLIC_KEY_PEM }),
    ).toBe(true);
    // Default known-keys map (which registers the dev key) also verifies.
    expect(await verifyFloorSignature(doc)).toBe(true);
  });

  it("rejects a doc whose signature was truncated / corrupted", async () => {
    const doc = await obsidianFloorDoc("0.1.0");
    const corrupted: FloorDocument = {
      ...doc,
      signature: doc.signature.slice(0, -2) + "00",
    };
    expect(await verifyFloorSignature(corrupted)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b2) node:crypto fallback path
// ---------------------------------------------------------------------------
//
// The verifier prefers WebCrypto but falls back to node:crypto when
// `subtle` Ed25519 is unavailable (older Electron / Capacitor-mobile shells).
// Dev + CI Node both support WebCrypto Ed25519 natively, so without forcing
// it the fallback branch (src/floor-preflight.ts createPublicKey + verify)
// never executes. These tests stub `globalThis.crypto.subtle` away so the
// node path - the one relied on for older mobile runtimes - is actually
// exercised in CI, not just hand-verified.

describe("Ed25519 verification - node:crypto fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies a correctly-signed doc via the node fallback", async () => {
    // subtle absent -> both computeKeyId's SHA-256 and the Ed25519 verify
    // must resolve through node:crypto.
    vi.stubGlobal("crypto", { subtle: undefined });
    expect(await computeKeyId(DEV_PUBLIC_KEY_PEM)).toBe(DEV_KEY_ID);
    const doc = await obsidianFloorDoc("0.1.0");
    expect(await verifyFloorSignature(doc)).toBe(true);
  });

  it("rejects a tampered doc via the node fallback", async () => {
    vi.stubGlobal("crypto", { subtle: undefined });
    const doc = await obsidianFloorDoc("0.1.0");
    const tampered: FloorDocument = {
      ...doc,
      floors: {
        "alter-obsidian": {
          min_version: "0.0.1",
          upgrade_cmd: OBSIDIAN_UPGRADE_CMD,
        },
      },
    };
    expect(await verifyFloorSignature(tampered)).toBe(false);
  });

  it("rejects an unknown key_id via the node fallback", async () => {
    vi.stubGlobal("crypto", { subtle: undefined });
    const doc = await signFloorDoc(
      {
        "alter-obsidian": {
          min_version: "0.1.0",
          upgrade_cmd: OBSIDIAN_UPGRADE_CMD,
        },
      },
      "2026-05-27T00:00:00Z",
      { keyId: "unknown1" },
    );
    expect(await verifyFloorSignature(doc)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) below-floor envelope
// ---------------------------------------------------------------------------

describe("preflightFloor - below floor", () => {
  it("emits canonical client_below_floor envelope when version below min", async () => {
    const doc = await obsidianFloorDoc("0.5.0");
    const http = mockHttp(doc);
    const cache = memCache();
    const result = await preflightFloor({
      clientVersion: "0.1.2",
      apiBase: "https://api.truealter.com",
      deps: { loadCache: cache.load, saveCache: cache.save, http },
    });
    expect(result.ok).toBe(false);
    expect(result.envelope).toBeDefined();
    const env = result.envelope as ClientBelowFloorEnvelope;
    expect(env.error.code).toBe("client_below_floor");
    expect(env.error.client_version).toBe("0.1.2");
    expect(env.error.min_version).toBe("0.5.0");
    expect(env.error.upgrade_cmd).toBe(OBSIDIAN_UPGRADE_CMD);
    expect(env.error.channel).toBe("obsidian-community");
    expect(env.error.message).toMatch(/below the minimum required version/);
  });

  it("blocks even when offline if stale (>7d) disk cache says below floor", async () => {
    vi.useFakeTimers();
    const now0 = Date.UTC(2026, 4, 1);
    vi.setSystemTime(now0);

    const oldDoc = await obsidianFloorDoc("0.5.0");
    // Pre-seed disk cache as if written 8 days ago.
    const cache = memCache();
    const eightDaysAgo = now0 - 8 * 24 * 60 * 60 * 1000;
    await cache.save({ doc: oldDoc, fetched_at_ms: eightDaysAgo });

    const http = mockHttp(null, { throwOnGet: new Error("offline") });
    const result = await preflightFloor({
      clientVersion: "0.1.2",
      apiBase: "https://api.truealter.com",
      deps: {
        loadCache: cache.load,
        saveCache: cache.save,
        http,
        now: () => now0,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toBe("below-floor-offline-stale-blocked");
  });
});

// ---------------------------------------------------------------------------
// (d) upgrade-prompt copy
// ---------------------------------------------------------------------------

describe("buildObsidianUpgradePrompt", () => {
  it("renders the channel-correct heading + body + upgrade_cmd", () => {
    const prompt = buildObsidianUpgradePrompt({
      currentVersion: "0.1.2",
      minVersion: "0.5.0",
    });
    expect(prompt.heading).toBe("~Alter plugin needs upgrade");
    expect(prompt.upgradeCmd).toBe(OBSIDIAN_UPGRADE_CMD);
    // Body MUST direct user to Community Plugins UI per Phase 4 spec.
    expect(prompt.body).toMatch(/Community plugins/);
    expect(prompt.body).toMatch(/Check for updates/);
    expect(prompt.body).toMatch(/0\.1\.2/);
    expect(prompt.body).toMatch(/0\.5\.0/);
  });

  it("summariseEnvelopeForNotice returns a one-line summary", () => {
    const env: ClientBelowFloorEnvelope = {
      error: {
        code: "client_below_floor",
        message: "stub",
        client_version: "0.1.2",
        min_version: "0.5.0",
        upgrade_cmd: OBSIDIAN_UPGRADE_CMD,
        channel: "obsidian-community",
      },
    };
    const line = summariseEnvelopeForNotice(env);
    expect(line).toContain("0.1.2");
    expect(line).toContain("0.5.0");
    expect(line).toContain(OBSIDIAN_UPGRADE_CMD);
    expect(line.split("\n").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (e) X-Alter-Client-* headers
// ---------------------------------------------------------------------------

describe("client-identification headers (§3)", () => {
  it("buildClientHeaders attaches X-Alter-Client-Id + Version", () => {
    const headers = buildClientHeaders("0.1.2");
    expect(headers["X-Alter-Client-Id"]).toBe("alter-obsidian");
    expect(headers["X-Alter-Client-Version"]).toBe("0.1.2");
    // No X-Alter-Client-Channel header - single-channel client.
    expect(headers["X-Alter-Client-Channel"]).toBeUndefined();
  });

  it("CLIENT_ID constant matches the §1 floor doc key", () => {
    expect(CLIENT_ID).toBe("alter-obsidian");
  });

  it("emitFloorRejectionAudit posts with X-Alter-Client-* headers attached", async () => {
    const http = mockHttp(null);
    const envelope: ClientBelowFloorEnvelope = {
      error: {
        code: "client_below_floor",
        message: "stub",
        client_version: "0.1.2",
        min_version: "0.5.0",
        upgrade_cmd: OBSIDIAN_UPGRADE_CMD,
        channel: "obsidian-community",
      },
    };
    await emitFloorRejectionAudit(
      "https://api.truealter.com",
      envelope,
      "0.1.2",
      http,
    );
    expect(http.postCalls.length).toBe(1);
    const call = http.postCalls[0];
    expect(call.url).toBe(
      `https://api.truealter.com${FLOOR_REJECTION_AUDIT_ENDPOINT}`,
    );
    expect(call.headers["X-Alter-Client-Id"]).toBe("alter-obsidian");
    expect(call.headers["X-Alter-Client-Version"]).toBe("0.1.2");
    expect(call.body).toMatchObject({
      client_id: "alter-obsidian",
      channel: "obsidian-community",
      client_version: "0.1.2",
      min_version: "0.5.0",
      source: "client-preflight",
    });
  });

  it("emitFloorRejectionAudit swallows POST failures (audit is best-effort)", async () => {
    const http = mockHttp(null, { throwOnPost: new Error("audit-down") });
    const envelope: ClientBelowFloorEnvelope = {
      error: {
        code: "client_below_floor",
        message: "stub",
        client_version: "0.1.2",
        min_version: "0.5.0",
        upgrade_cmd: OBSIDIAN_UPGRADE_CMD,
        channel: "obsidian-community",
      },
    };
    await expect(
      emitFloorRejectionAudit(
        "https://api.truealter.com",
        envelope,
        "0.1.2",
        http,
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

describe("compareSemver", () => {
  it("orders versions correctly", () => {
    expect(compareSemver("0.1.2", "0.1.2")).toBe(0);
    expect(compareSemver("0.1.2", "0.1.3")).toBeLessThan(0);
    expect(compareSemver("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });
  it("pre-release < release", () => {
    expect(compareSemver("1.0.0-rc1", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "1.0.0-rc1")).toBeGreaterThan(0);
  });
});
