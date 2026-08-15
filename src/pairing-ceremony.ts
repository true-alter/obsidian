/*
 * ~Alter - Pair your vault. Pairing-ceremony state machine.
 *
 * Walks the user from `unpaired` to `paired` through three confirmation
 * gates, then grants one `obsidian-vault/<subtag>` consent row per consented
 * subtag (per-subtag granular consent). Each transition
 * emits an Obsidian Notice via the supplied `notify` callback so the
 * rendering surface is testable in isolation.
 *
 * States:
 *   unpaired
 *      -> reading_session   (load ~/.config/alter/session.json)
 *      -> confirming        (show "Pair this vault to ~<handle>?" modal)
 *      -> granting          (one grant_vault per subtag, sequentially)
 *      -> paired            (write PAIRING.md)
 *      OR -> failed         (rollback, surface error)
 *
 * Consent model: Model A (member-self). Each grant is a
 * direct `alter_consent` `grant_vault` tools/call against the backend MCP
 * endpoint (NOT the retired daemon round-trip) and returns NO revocation
 * token - revocation authority is the member's own session. The granting
 * step is supplied as the injected `grantConsent` dep so this state machine
 * stays decoupled from the egress/HTTP plumbing and remains testable.
 * Stream tag is `obsidian-vault/<subtag>` (hyphenated, per-subtag).
 */

import { AlterFolder } from "./alter-folder";
import {
  AlterSession,
  PairingState,
  VaultSubtag,
  obsidianStream,
} from "./types";

export interface CeremonyDeps {
  folder: AlterFolder;
  /**
   * Grant consent for one stream (member-self). Resolves with the backend
   * `granted_at` timestamp (may be empty if the backend omits it). Throws on
   * failure. Wired in production to `directGrantConsent` (alter_consent
   * grant_vault); injected in tests.
   */
  grantConsent: (stream: string, vaultPathHash: string) => Promise<string>;
  /** Resolves the on-disk session.json. Injected for tests. */
  readSession: () => Promise<AlterSession | null>;
  /** Resolves a stable hash of the vault path. Injected for tests. */
  vaultPathHash: () => Promise<string>;
  /** UI surface for status messages. */
  notify: (msg: string, kind?: "info" | "error") => void;
  /** UI confirmation modal. Resolves true if the user confirms. */
  confirm: (handle: string) => Promise<boolean>;
  purposes?: string[];
  /** Subtags to grant. Defaults to ["journal", "manual-note"]. */
  subtags?: VaultSubtag[];
}

/** Per-subtag grant record returned to the plugin for persistence. */
export interface SubtagGrant {
  subtag: VaultSubtag;
  stream: string;
  granted_at: string;
}

export interface CeremonyResult {
  state: PairingState;
  handle?: string;
  pairedAt?: string;
  vaultPathHash?: string;
  /** Per-subtag grants (one per element of `deps.subtags`). */
  grants?: SubtagGrant[];
  error?: string;
}

/**
 * Canonical purposes whitelisted by the backend consent ledger.
 *
 * Reconciled - earlier scaffold values
 * (`theme_emergence`, `consequence_preview`, `income_attribution`) were
 * not in the ledger whitelist and would have caused `ValueError` on every
 * pairing. The ledger is the single source of truth - this list MUST
 * stay in sync.
 */
export const DEFAULT_PURPOSES = [
  "mirror_reflection",
  "identity_income",
  "search_amplification",
  "side_quest_nudge",
];

/**
 * Human-friendly labels for the four canonical purposes. The ledger key
 * `mirror_reflection` is retained at the wire/storage layer for backend
 * compatibility, but the user-facing label is "Reflection" - the full
 * Mirror UX does not surface at launch.
 */
export const PURPOSE_LABELS: Record<string, string> = {
  mirror_reflection: "Reflection",
  identity_income: "Identity income",
  search_amplification: "Search amplification",
  side_quest_nudge: "Side-quest nudges",
};

const DEFAULT_SUBTAGS: VaultSubtag[] = ["journal", "manual-note"];

export class PairingCeremony {
  private state: PairingState = "unpaired";

  constructor(private readonly deps: CeremonyDeps) {}

  current(): PairingState {
    return this.state;
  }

  /** Drive the full ceremony to a terminal state. */
  async pair(): Promise<CeremonyResult> {
    try {
      // unpaired -> reading_session
      this.transition("reading_session");
      this.deps.notify("Reading ~Alter session…");
      const session = await this.deps.readSession();
      if (!session || !session.handle) {
        return this.fail("No ~handle session found. Run `alter login` first.");
      }

      // reading_session -> confirming
      this.transition("confirming");
      const confirmed = await this.deps.confirm(session.handle);
      if (!confirmed) {
        // Reset to unpaired; not a failure.
        this.state = "unpaired";
        this.deps.notify("Pairing cancelled.", "info");
        return { state: "unpaired" };
      }

      // confirming -> granting (one grant per subtag)
      this.transition("granting");
      const vaultHash = await this.deps.vaultPathHash();
      const purposes = this.deps.purposes ?? DEFAULT_PURPOSES;
      const subtags = this.deps.subtags ?? DEFAULT_SUBTAGS;
      if (subtags.length === 0) {
        return this.fail(
          "At least one subtag must be selected before pairing.",
        );
      }

      const grants: SubtagGrant[] = [];
      for (const subtag of subtags) {
        const stream = obsidianStream(subtag);
        this.deps.notify(`Granting consent for ${stream}…`);
        let grantedAt: string;
        try {
          // Member-self direct grant (alter_consent grant_vault). No token.
          grantedAt = await this.deps.grantConsent(stream, vaultHash);
        } catch (err) {
          return this.fail(
            `Consent grant failed for ${stream}: ${(err as Error).message}`,
          );
        }

        grants.push({
          subtag,
          stream,
          granted_at: grantedAt || new Date().toISOString(),
        });
      }

      // granting -> paired (write PAIRING.md surface)
      try {
        await this.deps.folder.writePairing({
          handle: session.handle,
          vault_path_hash: vaultHash,
          granted_at: grants[0].granted_at,
          purposes,
          /** Streams granted (one ledger row per subtag). */
          subtags: grants.map((g) => g.subtag),
        });
      } catch (err) {
        return this.fail(`Vault write failed: ${(err as Error).message}`);
      }

      this.transition("paired");
      this.deps.notify(
        `Paired to ${session.handle} (${grants.length} subtag${grants.length === 1 ? "" : "s"}).`,
      );
      return {
        state: "paired",
        handle: session.handle,
        pairedAt: grants[0].granted_at,
        vaultPathHash: vaultHash,
        grants,
      };
    } catch (err) {
      return this.fail(`Unexpected error: ${(err as Error).message}`);
    }
  }

  private transition(next: PairingState): void {
    this.state = next;
  }

  private fail(message: string): CeremonyResult {
    this.state = "failed";
    this.deps.notify(message, "error");
    return { state: "failed", error: message };
  }
}
