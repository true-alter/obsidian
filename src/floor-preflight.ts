/*
 * floor-preflight: the minimum-version check the plugin runs on itself.
 *
 * ALTER publishes a signed floor document naming the oldest client version
 * each surface still accepts. This plugin loads once per Obsidian session and
 * stays resident, so it checks the floor at `onload()` rather than per call.
 * Below the floor it registers nothing except a single "ALTER plugin needs
 * upgrade" notice and shows the upgrade modal, so a stale plugin cannot half
 * work.
 *
 * What the check gives you:
 *   - Ed25519 signature verification with a key id, so a floor document
 *     cannot be forged or replayed from a retired key.
 *   - One below-floor payload shape, identical across every ALTER surface, so
 *     the same handling works wherever you meet it.
 *   - A cached floor written through Obsidian's own `saveData()`, which
 *     handles atomicity at the storage layer.
 *
 * Four things about the Obsidian API shape this code:
 *   1. Network goes through `requestUrl()` from the `obsidian` module rather
 *      than node `fetch`, because it is the CORS-safe primitive that works on
 *      both the desktop shell and the mobile one. Tests override it through
 *      the `fetchImpl` dependency.
 *   2. The cache persists via `this.loadData()` / `this.saveData()`, which
 *      writes to `.obsidian/plugins/<id>/data.json`. It rides the existing
 *      settings save channel rather than minting a file of its own, and the
 *      POSIX owner and mode checks other clients run do not apply, because
 *      Obsidian owns that directory.
 *   3. Nothing reads `process.platform` or `os.homedir()`. Obsidian abstracts
 *      both, and the plugin runs identical bytes on desktop and mobile.
 *   4. There is exactly one install channel, the Obsidian community catalogue,
 *      so no channel detection is needed.
 *
 * The server-side gate is what actually rejects a below-floor client. This
 * preflight is there so you get a clean Obsidian-native upgrade prompt instead
 * of a failed round trip.
 */

/*
 * crypto: prefer WebCrypto (globalThis.crypto.subtle) which is the
 * primitive available inside Obsidian's Electron-renderer + Capacitor-mobile
 * sandboxes (and also Node >=15). Ed25519 verification runs via
 * `subtle.importKey("spki", ...)` + `subtle.verify({ name: "Ed25519" }, ...)`;
 * we fall back to node:crypto (`createPublicKey` + `verify(null, ...)`) only
 * when subtle Ed25519 is unavailable. Both paths consume byte-identical
 * canonical-JSON input and the same SPKI-PEM public key, so either agrees with
 * the signer and with every other ALTER client that verifies the same
 * document. The floor PRIVATE key is never present on any client - the plugin
 * can verify but never forge. SHA-256 (for key_id derivation) likewise prefers
 * subtle.digest with a node:crypto fallback.
 */
import * as nodeCrypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CLIENT_ID = "alter-obsidian";
export const MIN_VERSION_ENDPOINT = "/v1/clients/min-version";
export const FLOOR_REJECTION_AUDIT_ENDPOINT = "/v1/clients/floor-rejection";

const IN_MEMORY_TTL_DEFAULT_MS = 60 * 60 * 1000; // 1h
const IN_MEMORY_TTL_MIN_MS = 60 * 1000; // 60s
const IN_MEMORY_TTL_MAX_MS = 24 * 60 * 60 * 1000; // 24h

const DISK_FRESH_MS = 24 * 60 * 60 * 1000; // 24h
const DISK_WARN_MS = 7 * 24 * 60 * 60 * 1000; // 7d

const FETCH_TIMEOUT_MS = 4000;

/**
 * Known Ed25519 public keys (SPKI PEM), keyed by `key_id` (first 8 hex chars
 * of SHA-256(raw 32-byte Ed25519 public key)). Asymmetric scheme: the backend
 * signs the floor document with a floor-only Ed25519 PRIVATE key that is never
 * shipped to any client; the plugin carries the PUBLIC half only and can
 * verify but never forge. Rotation is dual-key: a new key is published
 * alongside the old one and clients keep several, selecting by `key_id`.
 *
 * Add new keys additively, and remove an old key only once every deployed
 * client carries the new one. Use `computeKeyId(pem)` to re-derive and
 * validate each map key.
 *
 *   8aa59e05 - non-prod public key (public half only).
 *   640f7d9a - prod public key (public half only).
 */
export const KNOWN_FLOOR_PUBLIC_KEYS: Record<string, string> = {
  "8aa59e05": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgqw28dlniOuiTE1f4BxCPSEgMLaPtHsO8wN5RWEwEhE=
-----END PUBLIC KEY-----`,
  "640f7d9a": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARzvAWayDwHvZRfOZizGZe+/a7PF082WGhyMS3tx06H4=
-----END PUBLIC KEY-----`,
};

// ---------------------------------------------------------------------------
// Types - canonical envelope shared across HTTP 426 / MCP / WS / stdout JSON
// ---------------------------------------------------------------------------

export interface ClientBelowFloorEnvelope {
  error: {
    code: "client_below_floor";
    message: string;
    client_version: string;
    min_version: string;
    upgrade_cmd: string;
    channel: string;
  };
}

export interface ChannelFloor {
  min_version: string;
  upgrade_cmd: string;
}

export interface FloorDocument {
  floors: Record<string, ChannelFloor | Record<string, ChannelFloor>>;
  served_at: string;
  cache_ttl_seconds: number;
  signature: string;
  key_id: string;
}

/** Persistable cache entry stored via Obsidian's `saveData()`. */
export interface FloorDiskCacheEntry {
  doc: FloorDocument;
  fetched_at_ms: number;
}

export interface PreflightResult {
  ok: boolean;
  envelope?: ClientBelowFloorEnvelope;
  /** Warning emitted but operation still permitted (24h-7d stale cache). */
  warn?: string;
  /** Promoted to the caller for logging - which path bit. */
  diagnostic: string;
  /** Floor doc actually consulted (so caller can persist it). */
  doc?: FloorDocument;
  /** Age of consulted doc in ms; absent when fresh fetch on first call. */
  age_ms?: number;
}

/**
 * Minimal HTTP response shape that lets us swap Obsidian's `requestUrl` for
 * node `fetch` in tests. Both expose `json()` (via .json on requestUrl, via
 * Response.json on fetch). The adapter handles the difference.
 */
export interface FloorHttpClient {
  get(url: string): Promise<FloorDocument>;
  post(url: string, body: unknown, headers: Record<string, string>): Promise<void>;
}

export interface PreflightDeps {
  /** Cache I/O - injected so tests can keep state in memory. */
  loadCache: () => Promise<FloorDiskCacheEntry | null>;
  saveCache: (entry: FloorDiskCacheEntry) => Promise<void>;
  /** HTTP - production wires Obsidian's `requestUrl`; tests inject. */
  http: FloorHttpClient;
  /** Clock - injectable. */
  now?: () => number;
}

export interface PreflightOpts {
  clientVersion: string;
  apiBase: string;
  deps: PreflightDeps;
}

// ---------------------------------------------------------------------------
// In-memory cache (per-process)
// ---------------------------------------------------------------------------

interface MemEntry {
  doc: FloorDocument;
  fetched_at_ms: number;
  ttl_ms: number;
}

let memCache: MemEntry | null = null;

/** Test hook - reset the in-memory cache between tests. */
export function _resetInMemoryCache(): void {
  memCache = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Preflight the floor for the running Obsidian plugin. Returns
 * `{ ok: true }` when the plugin should register normally; otherwise
 * `{ ok: false, envelope }` with the canonical client_below_floor envelope.
 * Caller is responsible for rendering the modal + emitting the audit signal.
 */
export async function preflightFloor(
  opts: PreflightOpts,
): Promise<PreflightResult> {
  const now = opts.deps.now ?? Date.now;

  // 1. Fast path - in-memory cache hit.
  const memDoc = readInMemoryCache(now);
  if (memDoc) {
    return compareToFloor(memDoc, opts.clientVersion);
  }

  // 2. Disk cache path - Obsidian-managed plugin data.
  const diskEntry = await opts.deps.loadCache();
  const age = diskEntry ? now() - diskEntry.fetched_at_ms : Number.POSITIVE_INFINITY;

  // 3. Fetch if disk cache is stale or absent.
  let fetched: FloorDocument | null = null;
  let fetchError: string | null = null;
  if (!diskEntry || age > IN_MEMORY_TTL_DEFAULT_MS) {
    try {
      fetched = await fetchFloorDoc(opts.apiBase, opts.deps.http);
    } catch (err) {
      fetchError = (err as Error).message ?? "fetch-error";
    }
  }

  if (fetched) {
    // Successful fetch - write to disk + populate memory.
    const entry: FloorDiskCacheEntry = { doc: fetched, fetched_at_ms: now() };
    try {
      await opts.deps.saveCache(entry);
    } catch {
      // Cache write best-effort.
    }
    populateMemCache(fetched, now());
    const verdict = compareToFloor(fetched, opts.clientVersion);
    return { ...verdict, doc: fetched, age_ms: 0 };
  }

  // 4. Fetch failed (or skipped) - fall back to disk cache.
  if (diskEntry) {
    populateMemCache(diskEntry.doc, diskEntry.fetched_at_ms);
    const verdict = compareToFloor(diskEntry.doc, opts.clientVersion);
    if (age > DISK_WARN_MS) {
      // Cache >7d AND unreachable. If below floor -> BLOCK (§9). If above
      // floor -> permit with WARN.
      if (!verdict.ok) {
        return {
          ...verdict,
          doc: diskEntry.doc,
          age_ms: age,
          diagnostic: "below-floor-offline-stale-blocked",
        };
      }
      return {
        ok: true,
        warn: `floor cache is >7d old and backend unreachable (${fetchError ?? "no refresh attempted"}); permitting`,
        diagnostic: "stale-cache-permit-warn",
        doc: diskEntry.doc,
        age_ms: age,
      };
    }
    if (age > DISK_FRESH_MS) {
      // 24h-7d window: permit with warn.
      if (!verdict.ok) {
        return { ...verdict, doc: diskEntry.doc, age_ms: age };
      }
      return {
        ok: true,
        warn: `floor cache is ${Math.round(age / (60 * 60 * 1000))}h old; refresh recommended`,
        diagnostic: "warn-stale-permit",
        doc: diskEntry.doc,
        age_ms: age,
      };
    }
    return { ...verdict, doc: diskEntry.doc, age_ms: age };
  }

  // 5. No cache + fetch failed - permit (no offline lockout for first-run
  // with network blip). Server-side gate will catch below-floor on the
  // first real request.
  return {
    ok: true,
    warn: `floor unreachable (${fetchError ?? "unknown"}); proceeding without preflight`,
    diagnostic: "no-cache-no-fetch-permit",
  };
}

// ---------------------------------------------------------------------------
// Floor comparison
// ---------------------------------------------------------------------------

function compareToFloor(
  doc: FloorDocument,
  clientVersion: string,
): PreflightResult {
  const floor = lookupFloor(doc, CLIENT_ID);
  if (!floor) {
    return { ok: true, diagnostic: "no-floor-defined" };
  }
  if (compareSemver(clientVersion, floor.min_version) >= 0) {
    return { ok: true, diagnostic: "above-floor" };
  }
  const envelope: ClientBelowFloorEnvelope = {
    error: {
      code: "client_below_floor",
      message: `Your ~Alter Obsidian plugin (${clientVersion}) is below the minimum required version ${floor.min_version}.`,
      client_version: clientVersion,
      min_version: floor.min_version,
      upgrade_cmd: floor.upgrade_cmd,
      channel: "obsidian-community",
    },
  };
  return { ok: false, envelope, diagnostic: "below-floor" };
}

/**
 * Look up a `(client_id)` floor entry. Obsidian plugin has a single channel
 * so the floor is a flat ChannelFloor, never per-channel map. Per-channel
 * shape is tolerated for forward-compat (fall back to `unknown` row, then
 * any first entry, matching alter-cli's lookup).
 */
function lookupFloor(
  doc: FloorDocument,
  clientId: string,
): ChannelFloor | null {
  const clientEntry = doc.floors[clientId];
  if (!clientEntry) return null;
  if (isChannelFloor(clientEntry)) return clientEntry;
  // Per-channel map - prefer the `obsidian-community` channel, fall back to
  // `unknown` (wave-2 A17 - server seeds MAX floor under `unknown`).
  const byChannel = clientEntry;
  if (byChannel["obsidian-community"]) return byChannel["obsidian-community"];
  if (byChannel["unknown"]) return byChannel["unknown"];
  // Last resort - first entry.
  const first = Object.values(byChannel)[0];
  return first ?? null;
}

function isChannelFloor(
  v: ChannelFloor | Record<string, ChannelFloor>,
): v is ChannelFloor {
  return (
    typeof (v as ChannelFloor).min_version === "string" &&
    typeof (v as ChannelFloor).upgrade_cmd === "string"
  );
}

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

export function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPat, aPre] = parseSemver(a);
  const [bMaj, bMin, bPat, bPre] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  if (aPat !== bPat) return aPat - bPat;
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) return aPre.localeCompare(bPre);
  return 0;
}

function parseSemver(v: string): [number, number, number, string | null] {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  if (!m) return [0, 0, 0, null];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null];
}

// ---------------------------------------------------------------------------
// Ed25519 verification + canonical JSON (A3 + A18, Phase 1 canonical)
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys + emit compact JSON. Matches Python's
 * `json.dumps(obj, sort_keys=True, separators=(",", ":"))` byte-for-byte
 * for the floor doc payload shape. Arrays preserve order. Primitives pass
 * through. Required so the same `{floors, served_at}` payload signs to the
 * same bytes on the Phase 1 backend (Python) and Phase 3/4 clients (JS/TS).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Derive the 8-char `key_id` for an Ed25519 public key (SPKI PEM): the first 8
 * hex chars of SHA-256 over the RAW 32-byte Ed25519 public key, which is the
 * same derivation the signer uses. The key_id is a derived public identifier -
 * never key material - and lets the client pick the right verification key
 * from its known-keys map while two keys are live during a rotation.
 *
 * Ed25519 SPKI DER is a fixed 44-byte structure (RFC 8410): a 12-byte
 * algorithm-identifier prefix followed by the 32-byte raw public key, so the
 * raw key is the final 32 bytes of the decoded DER. Async because WebCrypto's
 * `subtle.digest` is async; the node:crypto fallback is wrapped to match.
 * Returns "00000000" for empty input (sentinel, mirrors Phase 1).
 */
export async function computeKeyId(publicKeyPem: string): Promise<string> {
  if (!publicKeyPem) return "00000000";
  const der = pemToDer(publicKeyPem);
  // RFC 8410 Ed25519 SPKI: 12-byte prefix + 32-byte raw key.
  const raw = der.length >= 32 ? der.subarray(der.length - 32) : der;
  const digest = await sha256Bytes(raw);
  return bytesToHex(digest).slice(0, 8);
}

/**
 * Verify the floor document's Ed25519 signature. Returns `true` on valid sig,
 * `false` on invalid signature or unknown `key_id`. The signed payload is the
 * canonical JSON of `{ floors, served_at }` - `signature` + `key_id` +
 * `cache_ttl_seconds` are excluded from the signed bytes.
 *
 * MUST stay byte-compatible with the signer and with every other ALTER client
 * that verifies the same document:
 *   - Algorithm: Ed25519 (RFC 8032). Deterministic - same key + payload = same sig.
 *   - Payload: `canonicalJson({ floors, served_at })` - sorted-keys + compact.
 *   - `key_id`: first 8 hex chars of SHA-256(raw 32-byte Ed25519 public key).
 *   - `signature`: hex-encoded 64-byte Ed25519 signature.
 *
 * WebCrypto path (mobile + modern Electron): `subtle.importKey("spki", ...)` +
 * `subtle.verify({ name: "Ed25519" }, ...)`. Node fallback (desktop / tests):
 * `createPublicKey` + `verify(null, ...)`. The `keys` parameter maps
 * `key_id → SPKI PEM`; defaults to `KNOWN_FLOOR_PUBLIC_KEYS`. Unknown key_id
 * returns false (triggers refetch via the rotation path). Verification failure
 * is never a forgery risk - only the holder of the never-shipped private key
 * can produce a signature that passes.
 */
export async function verifyFloorSignature(
  doc: FloorDocument,
  keys: Record<string, string> = KNOWN_FLOOR_PUBLIC_KEYS,
): Promise<boolean> {
  const pem = keys[doc.key_id];
  if (!pem) return false;
  // Re-derive key_id from the PEM - defends against a mis-keyed map entry.
  if ((await computeKeyId(pem)) !== doc.key_id) return false;
  const canonical = canonicalJson({
    floors: doc.floors,
    served_at: doc.served_at,
  });
  const msgBytes = new TextEncoder().encode(canonical);
  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(doc.signature);
  } catch {
    return false;
  }
  // WebCrypto path - the primitive available on mobile (Capacitor) + modern
  // Electron. Falls through to node:crypto on any failure (algorithm
  // unsupported, malformed key).
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
    ?.subtle;
  if (subtle && typeof subtle.importKey === "function") {
    try {
      const der = pemToDer(pem);
      const key = await subtle.importKey(
        "spki",
        der as BufferSource,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      return await subtle.verify(
        { name: "Ed25519" },
        key,
        sigBytes as BufferSource,
        msgBytes as BufferSource,
      );
    } catch {
      // Fall through to the node path below.
    }
  }
  // Node fallback - used by vitest and desktop Electron. `verify(null, ...)`
  // selects Ed25519 from the key type.
  try {
    const pubKey = nodeCrypto.createPublicKey({ key: pem, format: "pem" });
    return nodeCrypto.verify(
      null,
      Buffer.from(msgBytes),
      pubKey,
      Buffer.from(sigBytes),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Byte helpers (portable across WebCrypto-only and node runtimes)
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("invalid-hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Decode a base64 string to bytes without relying on node's Buffer being
 * present (mobile has no Buffer, but has `atob`). */
function base64ToBytes(b64: string): Uint8Array {
  const g = globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array }; atob?: (s: string) => string };
  if (typeof g.Buffer !== "undefined") {
    return new Uint8Array(g.Buffer.from(b64, "base64"));
  }
  const bin = (g.atob as (s: string) => string)(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Strip PEM armour + whitespace and base64-decode to DER bytes. */
function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(b64);
}

/** SHA-256 over bytes - prefers WebCrypto `subtle.digest`, node fallback. */
async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
    ?.subtle;
  if (subtle && typeof subtle.digest === "function") {
    const buf = await subtle.digest("SHA-256", bytes as BufferSource);
    return new Uint8Array(buf);
  }
  return new Uint8Array(nodeCrypto.createHash("sha256").update(bytes).digest());
}

// ---------------------------------------------------------------------------
// Fetch + audit
// ---------------------------------------------------------------------------

async function fetchFloorDoc(
  apiBase: string,
  http: FloorHttpClient,
): Promise<FloorDocument | null> {
  const url = joinUrl(apiBase, MIN_VERSION_ENDPOINT);
  let body: FloorDocument;
  try {
    body = await withTimeout(http.get(url), FETCH_TIMEOUT_MS);
  } catch (err) {
    throw new Error(`network: ${(err as Error).message}`);
  }
  if (!body || !body.floors || !body.signature || !body.key_id) {
    throw new Error("malformed-floor-doc");
  }
  if (!(await verifyFloorSignature(body))) {
    throw new Error("signature-invalid");
  }
  return body;
}

/**
 * Emit a `client_floor_rejection` audit signal to the backend (§2,
 * §"Audit trail"). Best-effort: failure to reach the backend during a
 * below-floor block is logged but never crashes the plugin. The server-side
 * gate emits the canonical audit signal on its own reject path; this is
 * the client-side complement when the preflight catches below-floor before
 * any daemon round-trip.
 */
export async function emitFloorRejectionAudit(
  apiBase: string,
  envelope: ClientBelowFloorEnvelope,
  clientVersion: string,
  http: FloorHttpClient,
): Promise<void> {
  const url = joinUrl(apiBase, FLOOR_REJECTION_AUDIT_ENDPOINT);
  const body = {
    client_id: CLIENT_ID,
    channel: envelope.error.channel,
    client_version: clientVersion,
    min_version: envelope.error.min_version,
    rejected_at: new Date().toISOString(),
    source: "client-preflight",
  };
  const headers = buildClientHeaders(clientVersion);
  try {
    await withTimeout(http.post(url, body, headers), FETCH_TIMEOUT_MS);
  } catch {
    // Best-effort - audit failure must never block the upgrade modal.
  }
}

// ---------------------------------------------------------------------------
// Client identification headers (§3)
// ---------------------------------------------------------------------------

/**
 * Build the X-Alter-Client-* header pair that MUST accompany every backend
 * HTTP call from the plugin (§3). The plugin has exactly one channel
 * ("obsidian-community"); no X-Alter-Client-Channel header is sent.
 */
export function buildClientHeaders(
  clientVersion: string,
): Record<string, string> {
  return {
    "X-Alter-Client-Id": CLIENT_ID,
    "X-Alter-Client-Version": clientVersion,
  };
}

// ---------------------------------------------------------------------------
// In-memory cache helpers
// ---------------------------------------------------------------------------

function readInMemoryCache(now: () => number): FloorDocument | null {
  if (!memCache) return null;
  if (now() - memCache.fetched_at_ms > memCache.ttl_ms) {
    memCache = null;
    return null;
  }
  return memCache.doc;
}

function populateMemCache(doc: FloorDocument, fetched_at_ms: number): void {
  const ttlSec = doc.cache_ttl_seconds ?? 3600;
  const ttlMs = Math.min(
    Math.max(ttlSec * 1000, IN_MEMORY_TTL_MIN_MS),
    IN_MEMORY_TTL_MAX_MS,
  );
  memCache = { doc, fetched_at_ms, ttl_ms: ttlMs };
}

// ---------------------------------------------------------------------------
// URL + timeout helpers
// ---------------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout-${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
