/*
 * ~Alter - Pair your vault. Plugin entry.
 *
 * Wires the alter-runtime daemon client, the ~Alter/ folder writer, and
 * the pairing ceremony into the Obsidian plugin lifecycle. Vault content
 * never leaves the device - only consented inferences, mediated by the
 * daemon, ever traverse the network.
 */

import {
  App,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginManifest,
  Setting,
  requestUrl,
} from "obsidian";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { AlterFolder, VaultAdapter } from "./alter-folder";
import {
  DaemonClient,
  defaultSocketPath,
} from "./daemon-client";
import {
  ClientBelowFloorEnvelope,
  FloorDiskCacheEntry,
  FloorDocument,
  FloorHttpClient,
  buildClientHeaders,
  emitFloorRejectionAudit,
  preflightFloor,
} from "./floor-preflight";
import {
  PairingCeremony,
  SubtagGrant,
} from "./pairing-ceremony";
import { AlterSettingTab } from "./settings";
import {
  AlterSession,
  DEFAULT_SETTINGS,
  PluginSettings,
  VaultSubtag,
  obsidianStream,
} from "./types";
import { buildObsidianUpgradePrompt } from "./upgrade-prompt";
import {
  RetryBufferEntry,
  RETRY_BUFFER_KEY,
  VaultEgressDeps,
  directGrantConsent,
  directRevokeConsent,
  obsidianPostJson,
  runEgress,
} from "./vault-egress";
import type { TraitSignal } from "./vault-trait-engine/types";

const STATUS_PAIRED = "alter-status-paired";
const STATUS_UNPAIRED = "alter-status-unpaired";

/** Default backend API base. Overridable via settings. */
const DEFAULT_API_BASE = "https://api.truealter.com";

/** Plugin-data key the floor cache lives under (Obsidian-managed storage). */
const FLOOR_CACHE_KEY = "__alter_floor_cache" as const;

export default class AlterPlugin extends Plugin {
  settings!: PluginSettings;
  private daemon?: DaemonClient;
  private statusBarItem?: HTMLElement;
  private folder?: AlterFolder;
  /** Minimum-version floor gate - true when plugin loaded below floor. */
  private belowFloor = false;
  private belowFloorEnvelope?: ClientBelowFloorEnvelope;

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    // Minimum-version floor gate - preflight the floor BEFORE registering
    // any commands / sidebar / status-bar surface. Below-floor: register a
    // single "~Alter plugin needs upgrade" command + show the modal once.
    const preflight = await this.runFloorPreflight();
    if (!preflight.ok && preflight.envelope) {
      this.belowFloor = true;
      this.belowFloorEnvelope = preflight.envelope;
      this.registerBelowFloorSurface(preflight.envelope);
      // Best-effort audit log; never blocks the modal.
      void emitFloorRejectionAudit(
        this.apiBase(),
        preflight.envelope,
        this.manifest.version,
        this.floorHttpClient(),
      );
      return;
    }
    if (preflight.warn) {
      console.warn(`[alter] floor preflight warning: ${preflight.warn}`);
    }

    this.folder = new AlterFolder(this.vaultAdapter());

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("alter-status-bar");
    this.refreshStatusBar();

    this.addRibbonIcon("file-text", "Open ~Alter/RETURN.md", () =>
      this.openReturn(),
    );

    this.addCommand({
      id: "pair-vault",
      name: "Pair this vault to your ~handle",
      callback: () => this.runPairingCeremony(),
    });
    this.addCommand({
      id: "show-return",
      name: "Open ~Alter/RETURN.md",
      callback: () => this.openReturn(),
    });
    this.addCommand({
      id: "unpair-vault",
      name: "Unpair this vault",
      callback: () => this.runUnpairCeremony(),
    });

    this.addSettingTab(new AlterSettingTab(this.app, this));

    if (this.settings.pairedHandle) {
      try {
        await this.folder.ensureFolder();
      } catch (err) {
        new Notice(
          `~Alter: could not ensure ~Alter/ folder (${(err as Error).message}).`,
        );
      }
    }

    if (this.canUseDaemon()) {
      this.connectDaemon();
    } else {
      // Mobile fallback - pairing requires desktop. Do NOT crash.
      // Surface the expectation only when the user attempts to pair.
    }
  }

  /* ------------------------------------------------------------------ */
  /* Minimum-version floor gate                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Run the floor preflight against the backend. Failure modes are
   * swallowed - the result is the single source of truth for the
   * downstream registration gate. Test hook: override via test-only
   * subclassing if needed.
   */
  async runFloorPreflight(): Promise<{
    ok: boolean;
    envelope?: ClientBelowFloorEnvelope;
    warn?: string;
    diagnostic: string;
  }> {
    try {
      const result = await preflightFloor({
        clientVersion: this.manifest.version,
        apiBase: this.apiBase(),
        deps: {
          loadCache: () => this.loadFloorCache(),
          saveCache: (entry) => this.saveFloorCache(entry),
          http: this.floorHttpClient(),
        },
      });
      return {
        ok: result.ok,
        envelope: result.envelope,
        warn: result.warn,
        diagnostic: result.diagnostic,
      };
    } catch (err) {
      // Total preflight failure - permit, log. Server-side gate still bites.
      console.warn(
        `[alter] floor preflight threw: ${(err as Error).message}; permitting load`,
      );
      return { ok: true, diagnostic: "preflight-threw" };
    }
  }

  /**
   * Below-floor registration: ONE command + show modal once. NO ribbon, NO
   * sidebar view, NO status-bar item, NO settings tab, NO daemon connection.
   */
  private registerBelowFloorSurface(envelope: ClientBelowFloorEnvelope): void {
    this.addCommand({
      id: "alter-plugin-needs-upgrade",
      name: "~Alter plugin needs upgrade",
      callback: () => this.showFloorBlockModal(envelope),
    });
    // Show the modal once on load so the user sees it immediately.
    try {
      this.showFloorBlockModal(envelope);
    } catch {
      // Fall back to a Notice if Modal fails (e.g. headless test env).
      try {
        new Notice(
          `~Alter plugin ${envelope.error.client_version} below minimum ${envelope.error.min_version}. ${envelope.error.upgrade_cmd}.`,
        );
      } catch {
        // Both surfaces unavailable - log only.
        console.error(
          "[alter] plugin below floor",
          envelope.error,
        );
      }
    }
  }

  protected showFloorBlockModal(envelope: ClientBelowFloorEnvelope): void {
    const prompt = buildObsidianUpgradePrompt({
      currentVersion: envelope.error.client_version,
      minVersion: envelope.error.min_version,
    });
    const modal = new FloorBlockModal(this.app, prompt.heading, prompt.body);
    modal.open();
  }

  /** Test hook - read floor cache from Obsidian-managed plugin data. */
  async loadFloorCache(): Promise<FloorDiskCacheEntry | null> {
    const raw = (await this.loadData()) as Record<string, unknown> | null;
    if (!raw) return null;
    const entry = raw[FLOOR_CACHE_KEY] as FloorDiskCacheEntry | undefined;
    if (!entry || !entry.doc || typeof entry.fetched_at_ms !== "number") {
      return null;
    }
    return entry;
  }

  /** Test hook - persist floor cache to Obsidian-managed plugin data. */
  async saveFloorCache(entry: FloorDiskCacheEntry): Promise<void> {
    const raw =
      ((await this.loadData()) as Record<string, unknown> | null) ?? {};
    raw[FLOOR_CACHE_KEY] = entry;
    await this.saveData(raw);
  }

  /** Backend API base. Hard-coded to prod for now (settings UI is Wave 2). */
  protected apiBase(): string {
    return DEFAULT_API_BASE;
  }

  /**
   * Build an Obsidian-native HTTP client backed by `requestUrl()` (CORS-safe,
   * mobile-compatible). Falls back to `fetch` only if `requestUrl` is
   * unavailable (the unit-test mock leaves it undefined).
   */
  protected floorHttpClient(): FloorHttpClient {
    return obsidianRequestUrlClient(this.manifest.version);
  }

  async onunload(): Promise<void> {
    if (this.daemon) {
      this.daemon.close();
      this.daemon = undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Settings persistence                                                */
  /* ------------------------------------------------------------------ */

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
    if (!this.settings.daemonSocketPath) {
      this.settings.daemonSocketPath = defaultSocketPath();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  defaultSocketPathHint(): string {
    return defaultSocketPath();
  }

  /* ------------------------------------------------------------------ */
  /* Daemon wiring                                                       */
  /* ------------------------------------------------------------------ */

  private canUseDaemon(): boolean {
    // Mobile (iOS/Android) lacks the Node `net` socket surface; desktop
    // Electron always has it. Modern Obsidian exposes `window.Capacitor`
    // on desktop too, so the canonical signal is `Platform.isDesktop`.
    // Fall back to `process.platform` when `Platform` is absent (test runs
    // under bare Node where this file is exercised without `obsidian`).
    if (typeof Platform !== "undefined" && typeof Platform.isDesktop === "boolean") {
      return Platform.isDesktop;
    }
    return typeof process !== "undefined" && !!process.platform;
  }

  private connectDaemon(): void {
    if (this.daemon) return;
    this.daemon = new DaemonClient({
      socketPath: this.settings.daemonSocketPath || defaultSocketPath(),
    });
    this.daemon.on("error", (err) => {
      console.warn("[alter] daemon error:", err);
    });
    // Wire-protocol event name "mirror" is intentionally retained - the
    // daemon emits return-event chunks under that legacy keyword and the
    // surface rename ("Mirror" → "Return") only applies to user-facing
    // strings, not the wire. Ledger purpose key `mirror_reflection` and
    // the daemon's emit name change together in a separate coordinated
    // pass; until then this listener stays.
    this.daemon.on("mirror", async (chunk) => {
      try {
        if (!this.folder) return;
        if (chunk.type === "summary") {
          await this.folder.appendReturn(chunk.body, chunk.ts);
        } else if (chunk.type === "theme" && chunk.ref) {
          await this.folder.writeTheme(chunk.ref, chunk.body);
        } else if (chunk.type === "consequence" && chunk.ref) {
          await this.folder.writeConsequence(chunk.ref, chunk.body);
        }
      } catch (err) {
        new Notice(
          `~Alter: failed to render return chunk (${(err as Error).message}).`,
        );
      }
    });
    this.daemon.connect();
  }

  /* ------------------------------------------------------------------ */
  /* Ceremonies                                                          */
  /* ------------------------------------------------------------------ */

  async runPairingCeremony(): Promise<void> {
    if (!this.canUseDaemon()) {
      new Notice(
        "~Alter: pairing requires desktop. Mobile read-only support lands later.",
      );
      return;
    }
    // Mirror streaming still uses the daemon; connecting here is best-effort
    // and NOT required for pairing (consent is granted member-self over MCP).
    this.connectDaemon();
    if (!this.folder) return;

    const ceremony = new PairingCeremony({
      folder: this.folder,
      grantConsent: (stream, vaultPathHash) =>
        this.grantConsentForStream(stream, vaultPathHash),
      readSession: () => readAlterSession(),
      vaultPathHash: () => this.computeVaultPathHash(),
      notify: (msg, kind) =>
        new Notice(kind === "error" ? `~Alter: ${msg}` : `~Alter: ${msg}`),
      confirm: (handle) => this.confirmPairing(handle),
      subtags: this.settings.consentedSubtags,
    });

    const result = await ceremony.pair();
    if (result.state === "paired" && result.handle && result.grants) {
      this.settings.pairedHandle = result.handle;
      this.settings.pairedAt = result.pairedAt ?? new Date().toISOString();
      this.settings.vaultPathHash = result.vaultPathHash ?? "";
      this.settings.consentedSubtags = result.grants.map((g) => g.subtag);
      await this.saveSettings();
      this.refreshStatusBar();
    }
  }

  /**
   * Grant consent for one stream member-self (alter_consent grant_vault).
   * Reads the session, resolves the API base, and delegates to
   * directGrantConsent. Used by the pairing ceremony's grantConsent dep.
   * Resolves with the backend `granted_at` (may be empty); throws on failure.
   */
  private async grantConsentForStream(
    stream: string,
    vaultPathHash: string,
  ): Promise<string> {
    const session = await readAlterSession();
    if (!session) {
      throw new Error("no session. Run `alter login` first");
    }
    return directGrantConsent(
      this.apiBase(),
      session,
      stream,
      vaultPathHash,
      this.manifest.version,
      { postJson: obsidianPostJson() },
    );
  }

  /**
   * Unpair ceremony — revokes every consented subtag grant directly via the
   * `alter_consent` MCP tool (member-self, Model A; daemonless).
   *
   * Revocation authority is the member's own session — no token needed.
   * Local pairing state is cleared only after every revoke succeeds; on any
   * failure local state is preserved so the unpair can be retried.
   */
  async runUnpairCeremony(): Promise<void> {
    if (!this.settings.pairedHandle) {
      new Notice("~Alter: vault is not paired.");
      return;
    }

    const session = await readAlterSession();
    if (!session) {
      new Notice("~Alter: no session. Run `alter login` first.");
      return;
    }

    const failures: string[] = [];
    for (const subtag of [...this.settings.consentedSubtags]) {
      try {
        await directRevokeConsent(
          this.apiBase(),
          session,
          obsidianStream(subtag),
          this.manifest.version,
          { postJson: obsidianPostJson() },
        );
      } catch (err) {
        failures.push(`${subtag} (${(err as Error).message})`);
      }
    }

    if (failures.length > 0) {
      new Notice(
        `~Alter: could not revoke ${failures.join(", ")}. ` +
          "Local pairing state PRESERVED. Retry unpair.",
      );
      return;
    }

    this.settings.pairedHandle = "";
    this.settings.pairedAt = "";
    this.settings.vaultPathHash = "";
    this.settings.consentedSubtags = [];
    await this.saveSettings();
    this.refreshStatusBar();
    new Notice("~Alter: vault unpaired. ~Alter/ folder contents preserved.");
  }

  /**
   * Per-subtag revoke — revokes directly via the `alter_consent` MCP tool
   * (member-self, Model A; daemonless). No token required;
   * revocation authority is the member's own session.
   */
  async revokeSubtag(subtag: VaultSubtag): Promise<void> {
    if (!this.settings.consentedSubtags.includes(subtag)) {
      new Notice(`~Alter: subtag "${subtag}" is not currently consented.`);
      return;
    }

    const session = await readAlterSession();
    if (!session) {
      new Notice("~Alter: no session. Run `alter login` first.");
      return;
    }

    const stream = obsidianStream(subtag);
    try {
      await directRevokeConsent(
        this.apiBase(),
        session,
        stream,
        this.manifest.version,
        { postJson: obsidianPostJson() },
      );
    } catch (err) {
      new Notice(`~Alter: revoke failed for "${subtag}": ${(err as Error).message}.`);
      return;
    }

    const set = new Set(this.settings.consentedSubtags);
    set.delete(subtag);
    this.settings.consentedSubtags = Array.from(set) as VaultSubtag[];
    await this.saveSettings();
    new Notice(`~Alter: revoked consent for "${subtag}".`);
  }

  /**
   * Granted-subtag toggle helper used by the settings UI. Adds a
   * subtag (running a per-subtag pairing grant) or removes one (running
   * a per-subtag revoke). Centralised so the settings tab does not have
   * to re-implement the daemon round-trip.
   */
  async toggleSubtagConsent(
    subtag: VaultSubtag,
    enabled: boolean,
  ): Promise<void> {
    if (enabled) {
      await this.grantSubtag(subtag);
    } else {
      await this.revokeSubtag(subtag);
    }
  }

  /**
   * Per-subtag grant — grants consent directly via the `alter_consent` MCP
   * tool (member-self, Model A; daemonless). No token returned.
   */
  private async grantSubtag(subtag: VaultSubtag): Promise<void> {
    if (this.settings.consentedSubtags.includes(subtag)) return;
    if (!this.settings.pairedHandle) {
      new Notice("~Alter: pair this vault first before granting subtags.");
      return;
    }

    const session = await readAlterSession();
    if (!session) {
      new Notice("~Alter: no session. Run `alter login` first.");
      return;
    }

    const stream = obsidianStream(subtag);
    try {
      await directGrantConsent(
        this.apiBase(),
        session,
        stream,
        this.settings.vaultPathHash,
        this.manifest.version,
        { postJson: obsidianPostJson() },
      );
    } catch (err) {
      new Notice(
        `~Alter: consent grant failed for ${stream}: ${(err as Error).message}.`,
      );
      return;
    }

    const set = new Set(this.settings.consentedSubtags);
    set.add(subtag);
    this.settings.consentedSubtags = Array.from(set) as VaultSubtag[];
    await this.saveSettings();
    new Notice(`~Alter: granted consent for "${subtag}".`);
  }

  /* ------------------------------------------------------------------ */
  /* Vault egress (Route 1 daemonless)                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Build the VaultEgressDeps wired to this plugin's Obsidian data store.
   * The retry buffer lives under RETRY_BUFFER_KEY in data.json.
   */
  buildEgressDeps(): VaultEgressDeps {
    return {
      loadRetryBuffer: async (): Promise<RetryBufferEntry[]> => {
        const raw = (await this.loadData()) as Record<string, unknown> | null;
        if (!raw) return [];
        const entries = raw[RETRY_BUFFER_KEY];
        if (!Array.isArray(entries)) return [];
        return entries as RetryBufferEntry[];
      },
      saveRetryBuffer: async (entries: RetryBufferEntry[]): Promise<void> => {
        const raw =
          ((await this.loadData()) as Record<string, unknown> | null) ?? {};
        raw[RETRY_BUFFER_KEY] = entries;
        await this.saveData(raw);
      },
      postJson: obsidianPostJson(),
      // wire appendMethodAuditRow to AlterFolder.appendMethodAudit
      // so each egressed signal's derivation provenance is persisted on-device
      // BEFORE the stripped payload is sent. No-ops gracefully when this.folder
      // is undefined (matches the `if (!this.folder) return` house idiom).
      appendMethodAuditRow: async (row) => {
        if (!this.folder) return;
        await this.folder.appendMethodAudit(row);
      },
    };
  }

  /**
   * Run vault egress for a single subtag's notes. Called after vault
   * scanning: derive → filter → POST (with retry buffer on failure).
   *
   * @param signals    filterToSinkAccepted()-filtered signals from the engine.
   */
  async egressVault(signals: TraitSignal[]): Promise<void> {
    if (signals.length === 0) return;
    const session = await readAlterSession();
    if (!session) {
      // No session — enqueue to retry buffer; drain on next successful login.
      const deps = this.buildEgressDeps();
      const buf = await deps.loadRetryBuffer();
      buf.push({ member_id: "", inferences: signals, queued_at: new Date().toISOString() });
      await deps.saveRetryBuffer(buf);
      return;
    }
    await runEgress(this.apiBase(), session, signals, this.manifest.version, this.buildEgressDeps());
  }

  /* ------------------------------------------------------------------ */
  /* UI helpers                                                          */
  /* ------------------------------------------------------------------ */

  private refreshStatusBar(): void {
    if (!this.statusBarItem) return;
    this.statusBarItem.removeClass(STATUS_PAIRED);
    this.statusBarItem.removeClass(STATUS_UNPAIRED);
    if (this.settings.pairedHandle) {
      this.statusBarItem.setText(this.settings.pairedHandle);
      this.statusBarItem.addClass(STATUS_PAIRED);
    } else {
      this.statusBarItem.setText("~unpaired");
      this.statusBarItem.addClass(STATUS_UNPAIRED);
    }
  }

  private async openReturn(): Promise<void> {
    if (!this.settings.pairedHandle) {
      new Notice("~Alter: pair this vault first.");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath("~Alter/RETURN.md");
    if (file && "extension" in file) {
      await this.app.workspace.getLeaf().openFile(file as any);
    } else {
      new Notice("~Alter: ~Alter/RETURN.md not yet rendered.");
    }
  }

  private vaultAdapter(): VaultAdapter {
    const adapter = this.app.vault.adapter as unknown as VaultAdapter;
    return adapter;
  }

  private async computeVaultPathHash(): Promise<string> {
    const base = (this.app.vault.adapter as unknown as { basePath?: string }).basePath;
    const seed = base ?? this.app.vault.getName();
    return crypto.createHash("sha256").update(seed, "utf8").digest("hex");
  }

  private confirmPairing(handle: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, handle, resolve);
      modal.open();
    });
  }
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly handle: string,
    private readonly done: (ok: boolean) => void,
  ) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Pair this vault?" });
    contentEl.createEl("p", {
      text: `You are about to pair this vault to ${this.handle}. Vault content stays on this device; the alter-runtime daemon will receive a per-subtag consent grant for inference only.`,
    });
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Confirm pairing")
          .setCta()
          .onClick(() => {
            this.done(true);
            this.close();
          }),
      )
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => {
          this.done(false);
          this.close();
        }),
      );
  }
}

/** Read `~/.config/alter/session.json`. Returns null if missing/malformed. */
async function readAlterSession(): Promise<AlterSession | null> {
  const home = os.homedir();
  const candidate = path.join(home, ".config", "alter", "session.json");
  try {
    const raw = await fs.readFile(candidate, "utf8");
    const parsed = JSON.parse(raw) as AlterSession;
    if (!parsed.handle || !parsed.user_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Minimum-version floor gate - below-floor block modal.
 *
 * Renders the channel-correct upgrade prompt (Community Plugins UI path).
 * Disables Esc-to-close so the user reads the upgrade path before
 * dismissing.
 */
class FloorBlockModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly bodyText: string,
  ) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.heading });
    // Multi-line body - split on newlines, render each as <p> with empty
    // strings preserved as visual spacers.
    for (const line of this.bodyText.split("\n")) {
      if (line === "") {
        contentEl.createEl("br");
      } else {
        contentEl.createEl("p", { text: line });
      }
    }
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("OK - I will upgrade")
        .setCta()
        .onClick(() => this.close()),
    );
  }
}

/**
 * Build an Obsidian-native `FloorHttpClient` that uses `requestUrl()` for
 * CORS-safe + mobile-compatible HTTP. The X-Alter-Client-* headers are
 * attached to EVERY call.
 *
 * Obsidian-API constraint: `requestUrl()` returns a synchronous-shaped
 * response with `.json` (already parsed). Node `fetch` returns a Response
 * with `.json()` (async). The adapter normalises both.
 */
export function obsidianRequestUrlClient(
  clientVersion: string,
): FloorHttpClient {
  const headers = buildClientHeaders(clientVersion);
  return {
    async get(url: string): Promise<FloorDocument> {
      // Use `requestUrl` when available (production) and `fetch` as the
      // test-side fallback (the obsidian mock leaves `requestUrl` undefined).
      if (typeof requestUrl === "function") {
        const resp = await requestUrl({
          url,
          method: "GET",
          headers: { ...headers, accept: "application/json" },
          throw: false,
        });
        if (resp.status < 200 || resp.status >= 300) {
          throw new Error(`http-${resp.status}`);
        }
        // `requestUrl` returns `.json` already parsed.
        return resp.json as FloorDocument;
      }
      const resp = await fetch(url, {
        headers: { ...headers, accept: "application/json" },
      });
      if (!resp.ok) throw new Error(`http-${resp.status}`);
      return (await resp.json()) as FloorDocument;
    },
    async post(
      url: string,
      body: unknown,
      extraHeaders: Record<string, string>,
    ): Promise<void> {
      const allHeaders = {
        ...headers,
        ...extraHeaders,
        "content-type": "application/json",
      };
      if (typeof requestUrl === "function") {
        const resp = await requestUrl({
          url,
          method: "POST",
          headers: allHeaders,
          body: JSON.stringify(body),
          throw: false,
        });
        if (resp.status < 200 || resp.status >= 300) {
          throw new Error(`http-${resp.status}`);
        }
        return;
      }
      const resp = await fetch(url, {
        method: "POST",
        headers: allHeaders,
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`http-${resp.status}`);
    },
  };
}

// Re-exports kept for tests.
export type { SubtagGrant };
