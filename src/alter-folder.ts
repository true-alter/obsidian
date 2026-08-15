import type { MethodAudit } from "./vault-trait-engine/types";

/*
 * ~Alter - Pair your vault. ~Alter/ folder writer.
 *
 * Manages the dedicated `~Alter/` return surface inside the user's vault.
 * Folder name is fixed (the vault's identity binding) and creation is idempotent.
 * All writes go through Obsidian's `Vault.adapter` so vault config is
 * respected (NOT raw fs).
 *
 * Layout:
 *   ~Alter/
 *     .alter-managed         sentinel + frontmatter warning
 *     PAIRING.md             handle, vault hash, granted_at, purposes
 *     RETURN.md              rolling synthesis of per-stream return events
 *     INCOME.md              Identity Income ledger (vault-sourced)
 *     THEMES/<slug>.md       emergent themes
 *     CONSEQUENCES/<date>.md consequence previews before promotion
 *
 * Vocabulary note: user-facing surfaces (this file's frontmatter, headings,
 * file paths, ribbon entries, settings UI) use "Return" - the full Mirror
 * UX does not surface at launch. Internal wire-protocol types and the ledger
 * purpose key `mirror_reflection` retain the legacy naming because the
 * consent ledger is append-only and the wire is coordinated with the daemon.
 */

export const ALTER_FOLDER = "~Alter";
export const THEMES_FOLDER = `${ALTER_FOLDER}/THEMES`;
export const CONSEQUENCES_FOLDER = `${ALTER_FOLDER}/CONSEQUENCES`;

const SENTINEL = `.alter-managed`;
const SENTINEL_PATH = `${ALTER_FOLDER}/${SENTINEL}`;
const RETURN_PATH = `${ALTER_FOLDER}/RETURN.md`;
const INCOME_PATH = `${ALTER_FOLDER}/INCOME.md`;
const PAIRING_PATH = `${ALTER_FOLDER}/PAIRING.md`;
export const METHOD_AUDIT_LEDGER_PATH = `${ALTER_FOLDER}/METHOD-AUDIT.ndjson`;

const SENTINEL_BODY = `---
managed_by: alter-obsidian-plugin
do_not_edit: true
---

This folder is managed by the ~Alter plugin. Files here are written by the
plugin as the per-stream return event for vault-sourced inferences. Edit
at your own risk - the plugin will overwrite or merge on subsequent
reflection cycles.
`;

const RETURN_HEADER = `---
title: Return
managed_by: alter-obsidian-plugin
---

# Return

Rolling synthesis of per-stream return events. Newest entries appear at the bottom.

`;

const INCOME_HEADER = `---
title: Identity Income
managed_by: alter-obsidian-plugin
---

# Identity Income - Vault-Sourced

Every consented inference deposited
into the identity field generates a return event. This ledger records
vault-sourced earnings only.

| Date | Stream | Amount | Tx |
| ---- | ------ | ------ | -- |
`;

/**
 * One row in the METHOD-AUDIT.ndjson ledger - the local
 * provenance record linking each egressed trait back to its derivation method.
 *
 * Keyed by `source_digest` (SHA-256 of contributing notes). The backend
 * receives `source_digest` but strips `method_audit`; this ledger is the
 * durable on-device link between the two.
 *
 * Layout matches the vault trait-engine mapping spec.
 */
export interface MethodAuditLedgerRow {
  /** SHA-256 hex digest — primary key, matches source_digest in the backend record */
  source_digest: string;
  /** Trait this derivation produced */
  trait_name: string;
  /** Stream subtag e.g. "obsidian-vault/manual-note" */
  stream_subtag: string;
  /** Full method audit — observables, weights, transform, calibration */
  method_audit: MethodAudit;
  /** ISO-8601 timestamp of the egress run that produced this row */
  recorded_at: string;
}

/**
 * Minimal subset of Obsidian's `DataAdapter` we depend on. Defined locally
 * so the unit tests can mock without pulling in the full Obsidian module.
 */
export interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  append?(path: string, data: string): Promise<void>;
}

export interface PairingFrontmatter {
  handle: string;
  vault_path_hash: string;
  granted_at: string;
  purposes: string[];
  /**
   * Streams granted (one ledger row per subtag). Granular
   * per-subtag consent. Consent is member-self (Model A):
   * there is no revocation token - revoke from any authenticated session via
   * the plugin's Settings tab.
   */
  subtags: string[];
}

export class AlterFolder {
  constructor(private readonly adapter: VaultAdapter) {}

  /** Create `~Alter/`, subfolders, and the sentinel if missing. Idempotent. */
  async ensureFolder(): Promise<void> {
    for (const folder of [ALTER_FOLDER, THEMES_FOLDER, CONSEQUENCES_FOLDER]) {
      if (!(await this.adapter.exists(folder))) {
        await this.adapter.mkdir(folder);
      }
    }
    if (!(await this.adapter.exists(SENTINEL_PATH))) {
      await this.adapter.write(SENTINEL_PATH, SENTINEL_BODY);
    }
    if (!(await this.adapter.exists(RETURN_PATH))) {
      await this.adapter.write(RETURN_PATH, RETURN_HEADER);
    }
    if (!(await this.adapter.exists(INCOME_PATH))) {
      await this.adapter.write(INCOME_PATH, INCOME_HEADER);
    }
  }

  /** Append a single timestamped line to RETURN.md. */
  async appendReturn(line: string, ts: string = new Date().toISOString()): Promise<void> {
    await this.ensureFolder();
    const entry = `\n## ${ts}\n\n${line.trim()}\n`;
    if (this.adapter.append) {
      await this.adapter.append(RETURN_PATH, entry);
      return;
    }
    const existing = await this.adapter.read(RETURN_PATH);
    await this.adapter.write(RETURN_PATH, existing + entry);
  }

  /** Idempotent write of a theme file under THEMES/. */
  async writeTheme(name: string, body: string): Promise<void> {
    await this.ensureFolder();
    const slug = slugify(name);
    const path = `${THEMES_FOLDER}/${slug}.md`;
    const content = themeBody(name, body);
    await this.adapter.write(path, content);
  }

  /** Append-or-create CONSEQUENCES/<YYYY-MM-DD>.md. */
  async writeConsequence(date: string, body: string): Promise<void> {
    await this.ensureFolder();
    const safeDate = date.replace(/[^0-9-]/g, "");
    const path = `${CONSEQUENCES_FOLDER}/${safeDate}.md`;
    const entry = `\n---\n\n${body.trim()}\n`;
    if (await this.adapter.exists(path)) {
      const existing = await this.adapter.read(path);
      await this.adapter.write(path, existing + entry);
      return;
    }
    await this.adapter.write(
      path,
      `---\ntitle: Consequence preview - ${safeDate}\nmanaged_by: alter-obsidian-plugin\n---\n\n# Consequence preview - ${safeDate}\n${entry}`,
    );
  }

  /**
   * Append a method_audit row to METHOD-AUDIT.ndjson.
   *
   * APPEND-ONLY and IDEMPOTENT on source_digest: if a row with the same
   * source_digest already exists in the ledger, this call is a no-op.
   * On a fresh egress run each trait produces a unique source_digest, so
   * two traits with different digest values always get separate rows even
   * if called in the same batch.
   *
   * The derivation method is persisted locally BEFORE the
   * stripped backend payload goes out. The link is source_digest →
   * ledger row; the backend record carries source_digest but not method_audit.
   */
  async appendMethodAudit(row: MethodAuditLedgerRow): Promise<void> {
    await this.ensureFolder();
    const line = JSON.stringify(row);
    // Idempotency: check if this source_digest is already recorded.
    if (await this.adapter.exists(METHOD_AUDIT_LEDGER_PATH)) {
      const existing = await this.adapter.read(METHOD_AUDIT_LEDGER_PATH);
      // Fast substring check on the source_digest value avoids full parse.
      if (existing.includes(`"source_digest":"${row.source_digest}"`)) {
        return; // already recorded — no-op
      }
      // Append a newline-separated row.
      if (this.adapter.append) {
        await this.adapter.append(METHOD_AUDIT_LEDGER_PATH, `\n${line}`);
        return;
      }
      await this.adapter.write(
        METHOD_AUDIT_LEDGER_PATH,
        existing.endsWith("\n") ? existing + line : `${existing}\n${line}`,
      );
      return;
    }
    // First row: create the file.
    await this.adapter.write(METHOD_AUDIT_LEDGER_PATH, line);
  }

  /** Write PAIRING.md. Member-self consent - no tokens are persisted here. */
  async writePairing(meta: PairingFrontmatter): Promise<void> {
    await this.ensureFolder();
    const subtags = meta.subtags;
    const subtagYaml =
      subtags.length === 0
        ? "  []"
        : subtags.map((subtag) => `  - ${JSON.stringify(subtag)}`).join("\n");
    const subtagList =
      subtags.length === 0
        ? "_(no subtags consented)_"
        : subtags
            .map(
              (subtag) => `- **${subtag}** - \`obsidian-vault/${subtag}\``,
            )
            .join("\n");
    const body =
      `---\n` +
      `handle: ${meta.handle}\n` +
      `vault_path_hash: ${meta.vault_path_hash}\n` +
      `granted_at: ${meta.granted_at}\n` +
      `purposes: [${meta.purposes.map((p) => JSON.stringify(p)).join(", ")}]\n` +
      `subtags:\n${subtagYaml}\n` +
      `managed_by: alter-obsidian-plugin\n` +
      `---\n\n` +
      `# Pairing\n\n` +
      `This vault is paired to **${meta.handle}** as of ${meta.granted_at}.\n\n` +
      `Purposes consented:\n\n` +
      meta.purposes.map((p) => `- ${p}`).join("\n") +
      `\n\nGranted subtags (one ledger row per subtag):\n\n` +
      subtagList +
      `\n\nConsent is member-self: revoke any subtag from any authenticated ` +
      `session via the plugin's Settings tab. No revocation token is ` +
      `required.\n`;
    await this.adapter.write(PAIRING_PATH, body);
  }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function themeBody(name: string, body: string): string {
  return (
    `---\ntitle: ${name}\nmanaged_by: alter-obsidian-plugin\n---\n\n` +
    `# ${name}\n\n${body.trim()}\n`
  );
}

export const PATHS = {
  ALTER_FOLDER,
  THEMES_FOLDER,
  CONSEQUENCES_FOLDER,
  SENTINEL_PATH,
  RETURN_PATH,
  INCOME_PATH,
  PAIRING_PATH,
  METHOD_AUDIT_LEDGER_PATH,
};
