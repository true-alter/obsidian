/*
 * ~Alter - Pair your vault. alter-runtime daemon client.
 *
 * Speaks JSONL over a unix socket (Linux/macOS) or named pipe (Windows).
 * Connection details discoverable from ~/.config/alter/session.json (read
 * by the existing `alter login` flow). Reconnects with exponential backoff;
 * surfaces failures via Obsidian Notice from the caller.
 *
 * Protocol cross-reference: ../docs/daemon-protocol.md (thin pointer to the
 * authoritative shape in the daemon protocol doc).
 *
 * Wire frame (reconciled with the companion daemon):
 *   {"method":"ingest","kind":"<op>","payload":{...}}
 *
 * Response frame:
 *   {"ok":true,"ingested":true,...}
 *   {"ok":false,"error":"<reason>"}
 *
 * Mirror chunks are streamed without the JSON-RPC envelope and carry an
 * explicit `op:"mirror_chunk"` discriminator (kept stable across the
 * reconciliation since they are not request/response).
 */

import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import {
  DaemonMessage,
  MirrorChunk,
  MirrorRequest,
  VaultConsentGrantRequest,
  VaultConsentGrantResponse,
  VaultConsentRevokeRequest,
  VaultConsentRevokeResponse,
} from "./types";

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_FACTOR = 2;

export interface DaemonClientOptions {
  socketPath: string;
  /** Override `net.createConnection` for tests. */
  connect?: (path: string) => net.Socket;
  /**
   * Override the auth-token reader. By default the daemon-minted token is
   * read from `<dirname(socketPath)>/alter-daemon-token` on every (re)connect
   * - so a daemon restart that mints a new token is picked up automatically.
   * Tests inject a fixed string.
   */
  readAuthToken?: () => string;
}

/**
 * Default token-file path: sibling of the socket, named `alter-daemon-token`.
 * Mirrors the daemon's :data:`alter_runtime.sockets.unix.TOKEN_FILENAME`
 * default. Same-UID processes read this file (mode 0o600).
 */
export function defaultTokenPath(socketPath: string): string {
  return path.join(path.dirname(socketPath), "alter-daemon-token");
}

/**
 * JSONL line splitter. Buffers partial chunks until a newline arrives.
 * Exported for direct unit testing without standing up a socket.
 */
export class LineBuffer {
  private buf = "";

  push(chunk: string | Buffer): string[] {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines: string[] = [];
    let idx = this.buf.indexOf("\n");
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line.length > 0) {
        lines.push(line);
      }
      idx = this.buf.indexOf("\n");
    }
    return lines;
  }
}

type DaemonRequest =
  | VaultConsentGrantRequest
  | VaultConsentRevokeRequest
  | MirrorRequest;

export class DaemonClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = new LineBuffer();
  private backoffMs = INITIAL_BACKOFF_MS;
  private intentionallyClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * `true` once the daemon has ACKed the auth handshake. Reset on every
   * close. The public `"connect"` event fires only after this flips -
   * callers see "connected" as "ready to send requests."
   */
  private authenticated = false;
  /** Pending requests, keyed by expected response op tag. */
  private pending = new Map<
    string,
    { resolve: (m: DaemonMessage) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly opts: DaemonClientOptions) {
    super();
  }

  /** Open (or reopen) the socket. Idempotent if already connected. */
  connect(): void {
    if (this.socket && !this.socket.destroyed) {
      return;
    }
    this.intentionallyClosed = false;
    this.authenticated = false;
    const factory =
      this.opts.connect ??
      ((p: string) => net.createConnection({ path: p }));
    try {
      this.socket = factory(this.opts.socketPath);
    } catch (err) {
      this.scheduleReconnect();
      this.emit("error", err);
      return;
    }
    this.socket.setEncoding("utf8");
    this.socket.on("connect", () => {
      // Daemon requires every method except `ping` to be preceded by a
      // token handshake. Read the daemon-minted token (or test injection)
      // and present it before emitting our public "connect" - callers must
      // not start writing until auth has cleared.
      let token: string;
      try {
        token = this.opts.readAuthToken
          ? this.opts.readAuthToken()
          : fs.readFileSync(defaultTokenPath(this.opts.socketPath), "utf8").trim();
      } catch (err) {
        const wrapped = new Error(
          `daemon auth: cannot read token at ${defaultTokenPath(this.opts.socketPath)}: ${
            (err as Error).message
          }`,
        );
        this.emit("error", wrapped);
        // Tear down so reconnect logic re-tries with a fresh read.
        if (this.socket) {
          this.socket.destroy();
        }
        return;
      }
      try {
        this.socket!.write(JSON.stringify({ method: "auth", token }) + "\n");
      } catch (err) {
        this.emit("error", err);
      }
      // Backoff doesn't reset until auth has actually cleared.
    });
    this.socket.on("data", (chunk: string | Buffer) => this.handleData(chunk));
    this.socket.on("error", (err: Error) => this.emit("error", err));
    this.socket.on("close", () => {
      this.authenticated = false;
      this.socket = null;
      this.emit("close");
      if (!this.intentionallyClosed) {
        this.scheduleReconnect();
      }
    });
  }

  /** Close the socket without scheduling a reconnect. */
  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
  }

  /** Send a request and resolve with the matching response tag. */
  async request<T extends DaemonMessage>(
    req: DaemonRequest,
    expectedOp: T["op"],
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("daemon socket not connected");
    }
    if (!this.authenticated) {
      throw new Error("daemon socket not authenticated");
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(expectedOp);
        reject(new Error(`daemon timeout for op=${expectedOp}`));
      }, timeoutMs);
      this.pending.set(expectedOp, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket!.write(JSON.stringify(req) + "\n");
    });
  }

  /** Stream Mirror chunks; caller subscribes via `on("mirror", handler)`. */
  requestMirror(req: MirrorRequest): void {
    if (!this.socket || this.socket.destroyed) {
      this.emit("error", new Error("daemon socket not connected"));
      return;
    }
    if (!this.authenticated) {
      this.emit("error", new Error("daemon socket not authenticated"));
      return;
    }
    this.socket.write(JSON.stringify(req) + "\n");
  }

  private handleData(chunk: string | Buffer): void {
    for (const line of this.buffer.push(chunk)) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.emit("error", new Error(`malformed JSONL: ${line}`));
        continue;
      }
      this.routeMessage(raw);
    }
  }

  private routeMessage(raw: Record<string, unknown>): void {
    // Pre-auth gate: the only frame we accept before authentication is the
    // daemon's response to our `auth` handshake. `ok:true` + the explicit
    // `authenticated:true` discriminator clears the gate; anything else
    // (auth error, malformed frame, premature mirror chunk) tears down the
    // socket so the reconnect logic re-tries with a fresh token read.
    if (!this.authenticated) {
      if (raw.ok === true && raw.authenticated === true) {
        this.authenticated = true;
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.emit("connect");
        return;
      }
      const error = new Error(
        `daemon auth failed: ${
          typeof raw.error === "string" ? raw.error : JSON.stringify(raw)
        }`,
      );
      this.emit("error", error);
      if (this.socket) {
        this.socket.destroy();
      }
      return;
    }

    // Mirror chunk frames carry their own discriminator and stream out
    // unsolicited; pass them straight through to listeners.
    if (raw.op === "mirror_chunk") {
      this.emit("mirror", raw as unknown as MirrorChunk);
      return;
    }

    // Reconciled response frame: {"ok":true|false, ...}.
    if (typeof raw.ok === "boolean") {
      if (raw.ok === false) {
        const error = new Error(
          typeof raw.error === "string" ? raw.error : "daemon error",
        );
        // Reject all pending - the daemon doesn't tag errors with a kind,
        // so the only safe behaviour is to fail the in-flight request(s)
        // and surface to listeners.
        for (const [, p] of this.pending) p.reject(error);
        this.pending.clear();
        this.emit("error", error);
        return;
      }
      // ok:true - find the pending request that's awaiting a response and
      // synthesise the local routing tag.
      const next = this.pending.entries().next();
      if (next.done) {
        this.emit("message", raw as unknown as DaemonMessage);
        return;
      }
      const [tag, pending] = next.value;
      this.pending.delete(tag);
      // Synthesise the legacy `op` routing tag for callers + carry
      // grant/revoke fields directly off the raw frame.
      const tagged = { ...raw, op: tag } as unknown as DaemonMessage;
      pending.resolve(tagged);
      return;
    }

    // Legacy fallback: explicit `op` field.
    const op = typeof raw.op === "string" ? raw.op : undefined;
    if (op === "error") {
      const code = typeof raw.code === "string" ? raw.code : "error";
      const msg =
        typeof raw.message === "string"
          ? raw.message
          : typeof raw.error === "string"
            ? raw.error
            : "daemon error";
      const err = new Error(`${code}: ${msg}`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.emit("error", err);
      return;
    }
    if (op && this.pending.has(op)) {
      const pending = this.pending.get(op)!;
      this.pending.delete(op);
      pending.resolve(raw as unknown as DaemonMessage);
      return;
    }
    this.emit("message", raw as unknown as DaemonMessage);
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * BACKOFF_FACTOR, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

/**
 * Default socket / named-pipe path per platform.
 *
 * Reconciled against the companion daemon's socket-path config -
 * the authoritative shape. Both sides must point at the same physical
 * socket the alter-runtime daemon binds to.
 *
 *   Linux:   `${XDG_RUNTIME_DIR}/alter.sock` (fallback `/tmp/alter-<uid>.sock`)
 *   macOS:   `~/Library/Application Support/alter/runtime.sock`
 *   Windows: `\\.\pipe\alter-runtime`
 */
export function defaultSocketPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    return "\\\\.\\pipe\\alter-runtime";
  }
  if (platform === "darwin") {
    const home = env.HOME ?? "";
    return `${home}/Library/Application Support/alter/runtime.sock`;
  }
  // Linux / other unix.
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) return `${xdg}/alter.sock`;
  const uid = process.getuid?.() ?? "anon";
  return `/tmp/alter-${uid}.sock`;
}

export type { VaultConsentGrantResponse, VaultConsentRevokeResponse };
