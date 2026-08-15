import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import {
  DaemonClient,
  LineBuffer,
  defaultSocketPath,
  defaultTokenPath,
} from "../src/daemon-client";
import type { VaultConsentGrantResponse } from "../src/types";

/** Minimal in-memory Socket mock that satisfies the daemon client. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  written: string[] = [];
  setEncoding(_: string): void {}
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  end(): void {
    this.destroyed = true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

/**
 * Helper: drive a fake socket through connect → daemon-side auth ACK so the
 * client emits its public `"connect"` event. Auth-token reader is injected
 * to avoid touching the real filesystem in unit tests.
 */
function driveAuth(sock: FakeSocket): void {
  sock.emit("connect");
  // The first write is the auth handshake; the second onwards are real
  // requests. Drain the auth frame and ACK it.
  expect(sock.written.length).toBeGreaterThanOrEqual(1);
  const authFrame = JSON.parse(sock.written[0]);
  expect(authFrame).toEqual({ method: "auth", token: "test-token" });
  sock.written.shift();
  sock.emit(
    "data",
    JSON.stringify({ ok: true, authenticated: true }) + "\n",
  );
}

describe("LineBuffer", () => {
  it("yields complete lines only", () => {
    const buf = new LineBuffer();
    expect(buf.push("hello")).toEqual([]);
    expect(buf.push(" world\n")).toEqual(["hello world"]);
  });

  it("handles multiple lines in one chunk", () => {
    const buf = new LineBuffer();
    expect(buf.push("a\nb\nc")).toEqual(["a", "b"]);
    expect(buf.push("\n")).toEqual(["c"]);
  });

  it("ignores empty lines", () => {
    const buf = new LineBuffer();
    expect(buf.push("\n\n\nx\n")).toEqual(["x"]);
  });
});

describe("DaemonClient", () => {
  it("frames JSONL writes with the reconciled JSON-RPC shape", async () => {
    const sock = new FakeSocket();
    const client = new DaemonClient({
      socketPath: "/tmp/fake",
      connect: () => sock as any,
      readAuthToken: () => "test-token",
    });
    client.connect();
    driveAuth(sock);

    const promise = client.request<VaultConsentGrantResponse>(
      {
        method: "ingest",
        kind: "vault_consent_grant",
        payload: {
          user_id: "m1",
          stream: "obsidian-vault/journal",
          vault_path_hash: "h1",
          purposes: ["mirror_reflection"],
        },
      },
      "vault_consent_grant_response",
    );

    expect(sock.written.length).toBe(1);
    expect(sock.written[0].endsWith("\n")).toBe(true);
    const parsed = JSON.parse(sock.written[0]);
    expect(parsed.method).toBe("ingest");
    expect(parsed.kind).toBe("vault_consent_grant");
    expect(parsed.payload.stream).toBe("obsidian-vault/journal");
    expect(parsed.payload.purposes).toEqual(["mirror_reflection"]);

    // Reply with the reconciled `{ok:true,...}` response shape.
    sock.emit(
      "data",
      JSON.stringify({
        ok: true,
        ingested: true,
        event_id: "e1",
        revocation_token: "tok-plain",
        granted_at: "2026-04-25T12:00:00Z",
      }) + "\n",
    );

    const resp = await promise;
    expect(resp.event_id).toBe("e1");
    expect(resp.revocation_token).toBe("tok-plain");
    expect(resp.op).toBe("vault_consent_grant_response");
  });

  it("routes mirror_chunk frames to listeners", async () => {
    const sock = new FakeSocket();
    const client = new DaemonClient({
      socketPath: "/tmp/fake",
      connect: () => sock as any,
      readAuthToken: () => "test-token",
    });
    const chunks: any[] = [];
    client.on("mirror", (c) => chunks.push(c));
    client.connect();
    driveAuth(sock);
    sock.emit(
      "data",
      JSON.stringify({
        op: "mirror_chunk",
        type: "summary",
        body: "rolling synthesis",
        ts: "2026-04-25T13:00:00Z",
      }) + "\n",
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].body).toBe("rolling synthesis");
  });

  it("rejects pending requests when daemon emits {ok:false,error:...}", async () => {
    const sock = new FakeSocket();
    const client = new DaemonClient({
      socketPath: "/tmp/fake",
      connect: () => sock as any,
      readAuthToken: () => "test-token",
    });
    client.on("error", () => {});
    client.connect();
    driveAuth(sock);
    const p = client.request(
      {
        method: "ingest",
        kind: "vault_consent_grant",
        payload: {
          user_id: "m1",
          stream: "obsidian-vault/journal",
          vault_path_hash: "h1",
          purposes: ["mirror_reflection"],
        },
      },
      "vault_consent_grant_response",
      500,
    );
    sock.emit(
      "data",
      JSON.stringify({
        ok: false,
        error: "consent_denied",
      }) + "\n",
    );
    await expect(p).rejects.toThrow(/consent_denied/);
  });

  it("schedules reconnect when the socket closes unexpectedly", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory = () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as any;
    };
    const client = new DaemonClient({
      socketPath: "/tmp/fake",
      connect: factory,
      readAuthToken: () => "test-token",
    });
    client.on("error", () => {});
    client.connect();
    sockets[0].emit("connect");
    sockets[0].emit("close");

    // Backoff timer fires.
    await vi.advanceTimersByTimeAsync(300);
    expect(sockets.length).toBe(2);
    client.close();
    vi.useRealTimers();
  });

  it("sends the auth handshake before emitting connect", async () => {
    const sock = new FakeSocket();
    const client = new DaemonClient({
      socketPath: "/tmp/fake",
      connect: () => sock as any,
      readAuthToken: () => "secret-token-xyz",
    });
    let connectFired = false;
    client.on("connect", () => {
      connectFired = true;
    });

    client.connect();
    sock.emit("connect");

    // Auth frame is the first thing on the wire.
    expect(sock.written.length).toBe(1);
    expect(JSON.parse(sock.written[0])).toEqual({
      method: "auth",
      token: "secret-token-xyz",
    });
    // Public `connect` does NOT fire until the daemon ACKs the handshake.
    expect(connectFired).toBe(false);

    sock.emit(
      "data",
      JSON.stringify({ ok: true, authenticated: true }) + "\n",
    );
    expect(connectFired).toBe(true);
  });

  it("destroys the socket and emits error on auth failure", async () => {
    const sock = new FakeSocket();
    const client = new DaemonClient({
      socketPath: "/tmp/fake",
      connect: () => sock as any,
      readAuthToken: () => "wrong-token",
    });
    const errors: Error[] = [];
    client.on("error", (e) => errors.push(e));

    client.connect();
    sock.emit("connect");
    sock.emit(
      "data",
      JSON.stringify({ ok: false, error: "auth: invalid token" }) + "\n",
    );

    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/auth failed.*invalid token/);
    expect(sock.destroyed).toBe(true);
  });

  it("rejects request() before auth has cleared", async () => {
    const sock = new FakeSocket();
    const client = new DaemonClient({
      socketPath: "/tmp/fake",
      connect: () => sock as any,
      readAuthToken: () => "test-token",
    });

    client.connect();
    sock.emit("connect"); // Auth frame written, but no ACK yet.

    await expect(
      client.request(
        {
          method: "ingest",
          kind: "vault_consent_grant",
          payload: {
            user_id: "m1",
            stream: "obsidian-vault/journal",
            vault_path_hash: "h1",
            purposes: ["mirror_reflection"],
          },
        },
        "vault_consent_grant_response",
        100,
      ),
    ).rejects.toThrow(/not authenticated/);
  });

  it("emits error and tears down when the token file is unreadable", async () => {
    const sock = new FakeSocket();
    const client = new DaemonClient({
      socketPath: "/tmp/fake",
      connect: () => sock as any,
      readAuthToken: () => {
        throw new Error("ENOENT");
      },
    });
    const errors: Error[] = [];
    client.on("error", (e) => errors.push(e));

    client.connect();
    sock.emit("connect");

    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/cannot read token.*ENOENT/);
    expect(sock.destroyed).toBe(true);
  });
});

describe("defaultTokenPath", () => {
  it("siblings the socket path with `alter-daemon-token`", () => {
    expect(defaultTokenPath("/run/user/1000/alter.sock")).toBe(
      "/run/user/1000/alter-daemon-token",
    );
    expect(
      defaultTokenPath("/Users/example/Library/Application Support/alter/runtime.sock"),
    ).toBe(
      "/Users/example/Library/Application Support/alter/alter-daemon-token",
    );
  });
});

describe("defaultSocketPath - cross-repo alignment", () => {
  /*
   * The plugin and the companion daemon MUST point at the same default
   * daemon socket path on every supported OS. The values below are
   * duplicated from the companion daemon's socket-path config. If
   * the companion daemon's shape ever diverges from these expectations,
   * this test fails - forcing a coordinated update.
   */
  it("matches the daemon socket path - Windows named pipe", () => {
    expect(defaultSocketPath("win32", {})).toBe("\\\\.\\pipe\\alter-runtime");
  });
  it("matches the daemon socket path - macOS Application Support path", () => {
    expect(defaultSocketPath("darwin", { HOME: "/Users/example" })).toBe(
      "/Users/example/Library/Application Support/alter/runtime.sock",
    );
  });
  it("matches the daemon socket path - XDG_RUNTIME_DIR/alter.sock on linux", () => {
    expect(
      defaultSocketPath("linux", { XDG_RUNTIME_DIR: "/run/user/1000" }),
    ).toBe("/run/user/1000/alter.sock");
  });
  it("matches the daemon socket path - /tmp fallback on linux without XDG_RUNTIME_DIR", () => {
    const result = defaultSocketPath("linux", {});
    expect(result.startsWith("/tmp/alter-")).toBe(true);
    expect(result.endsWith(".sock")).toBe(true);
  });
});
