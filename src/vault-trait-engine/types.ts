/**
 * vault-trait-engine/types.ts
 *
 * Host-agnostic types for the Obsidian vault → trait derivation engine.
 * No Obsidian imports here — only stdlib-compatible types so the engine
 * is unit-testable offline.
 *
 * Wire shape matches the backend `vault_ingest` MCP tool.
 */

// ---------------------------------------------------------------------------
// Host-agnostic Note representation
// ---------------------------------------------------------------------------

/**
 * Normalised, host-independent note. The Obsidian adapter converts TFile[] +
 * MetadataCache into this shape; tests build it directly without needing
 * the Obsidian runtime.
 */
export interface Note {
  /** Vault-relative path, e.g. "Journal/2026-01-01.md" */
  path: string;
  /** Modification timestamp in ms since epoch */
  mtimeMs: number;
  /** Creation timestamp in ms since epoch */
  ctimeMs: number;
  /** Raw character count (not word count — cheaper, deterministic) */
  contentLength: number;
  /** Frontmatter key→value pairs (string values only, coerced by adapter) */
  frontmatter: Record<string, string>;
  /**
   * Outbound wikilink targets (display text or first alias stripped, vault-
   * relative paths). Resolved from metadataCache.getFileCache(f).links.
   */
  outboundLinks: string[];
  /**
   * Tag strings without the leading #, e.g. ["project/alter", "daily"].
   * Resolved from metadataCache.getFileCache(f).tags.
   */
  tags: string[];
  /**
   * Vault-relative folder path (dirname of `path`), e.g. "Journal" or
   * "Projects/Research". Empty string for root-level notes.
   */
  folder: string;
}

// ---------------------------------------------------------------------------
// Emitted wire shape
// ---------------------------------------------------------------------------

/**
 * Method-audit field: the derivation-provenance record.
 * Carries which observables fed this signal, their raw values, and the
 * transform applied so the derivation is fully reconstructable.
 */
export interface MethodAudit {
  /** Observable name → raw value (before sigmoid/softmax) */
  observables: Record<string, number>;
  /** Weighted pre-sigmoid composite value */
  weighted_raw: number;
  /** Transform applied: "sigmoid" | "sigmoid_softmax" */
  transform: "sigmoid" | "sigmoid_softmax";
  /**
   * Calibration band used for sigmoid min-max normalisation:
   * [min, max] defining the [0,1] output range endpoints.
   */
  calibration_band: [number, number];
}

/**
 * Wire-shape for one emitted trait signal. Must satisfy backend vault_ingest
 * schema (the mapping spec). Value is in [0,1] (a valid subset of the
 * sink's accepted [-1,1]).
 *
 * VALUE CONVENTION DECISION (2026-06-05):
 * Emit sigmoid/softmax outputs in [0,1] (unipolar). The backend sink accepts
 * [-1,1] and the [0,1] subset is always valid. A parallel falsification agent
 * is verifying whether softmax pairs need bipolar [-1,1] remap; until that
 * verdict lands, both softmax pair traits are emitted as distinct named
 * [0,1] scores so the merger can handle them as independent continuous traits
 * without a sign-flip. Isolated in `toWireValue()` — one change point.
 */
export interface TraitSignal {
  trait_name: string;
  /** [0,1] — σ or softmax output, never negative in this engine version */
  value: number;
  /** [0.15, 0.30] — Tier-2 self-cap; sink re-clamps as defence-in-depth */
  confidence: number;
  provenance_class: "passive_local_document";
  /** e.g. "obsidian-vault/manual-note" */
  stream_subtag: string;
  /** SHA-256 hex (64 chars) of aggregate contributing-note digest */
  source_digest: string;
  method_audit: MethodAudit;
}

// ---------------------------------------------------------------------------
// Subtag
// ---------------------------------------------------------------------------

/** Vault subtags matching the consent grain from the spec. */
export type VaultSubtag =
  | "journal"
  | "manual-note"
  | "reading-note"
  | "daily"
  | "meeting-minutes";
