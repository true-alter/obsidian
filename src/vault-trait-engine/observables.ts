/**
 * vault-trait-engine/observables.ts
 *
 * §2 raw observables — pure functions over Note[].
 * LLM-free, stdlib-only. No I/O, no network, no model, no keyword lists.
 * Computes file-metadata stats, link-graph topology, taxonomy entropy,
 * cadence, and cheap structural lexical stats.
 *
 * All functions accept a Note[] and return a number (or derived structure).
 * The Obsidian adapter is the only Obsidian-coupled file; these functions
 * are host-agnostic and unit-testable offline.
 */

import type { Note } from "./types.js";

// ---------------------------------------------------------------------------
// Span helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** Return unique mtime-days for a single note (crude revision intensity proxy). */
function mtimeDaysForNote(_note: Note): number {
  // Without git history, we have a single mtime per note from the vault.
  // A single mtime → 1 distinct mtime-day. Future enhancement: if the
  // adapter exposes a history array, count distinct days. v1: always 1.
  return 1;
}

// ---------------------------------------------------------------------------
// §2 observables
// ---------------------------------------------------------------------------

/** note_count — total notes in the batch. */
export function noteCount(notes: Note[]): number {
  return notes.length;
}

/**
 * active_months: span between earliest and latest note mtime in months
 * (30.44 days/month, matching the backend's convention).
 */
export function activeMonths(notes: Note[]): number {
  if (notes.length === 0) return 0;
  const mtimes = notes.map((n) => n.mtimeMs);
  const spanMs = Math.max(...mtimes) - Math.min(...mtimes);
  return spanMs / (30.44 * MS_PER_DAY);
}

/** active_span_days — span in days (used for the universal floor gate). */
export function activeSpanDays(notes: Note[]): number {
  if (notes.length === 0) return 0;
  const mtimes = notes.map((n) => n.mtimeMs);
  return (Math.max(...mtimes) - Math.min(...mtimes)) / MS_PER_DAY;
}

/**
 * mean_note_len — mean note length in chars.
 */
export function meanNoteLen(notes: Note[]): number {
  if (notes.length === 0) return 0;
  return notes.reduce((s, n) => s + n.contentLength, 0) / notes.length;
}

/**
 * p25_note_len — 25th-percentile note length (used for concept_note_ratio).
 */
export function p25NoteLen(notes: Note[]): number {
  if (notes.length === 0) return 0;
  const sorted = notes.map((n) => n.contentLength).sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.25);
  return sorted[idx] ?? 0;
}

/**
 * median_link_density — median outbound wikilinks per note
 * (used for concept_note_ratio gate).
 */
export function medianLinkDensity(notes: Note[]): number {
  if (notes.length === 0) return 0;
  const densities = notes.map((n) => n.outboundLinks.length).sort((a, b) => a - b);
  const mid = Math.floor(densities.length / 2);
  if (densities.length % 2 === 1) {
    return densities[mid] ?? 0;
  }
  return ((densities[mid - 1] ?? 0) + (densities[mid] ?? 0)) / 2;
}

/**
 * daily_coverage — fraction of days in the active span that have a daily/
 * journal note (detected by the folder or a date-like filename).
 * A day "has a note" if any note's mtime falls within that calendar day.
 */
export function dailyCoverage(notes: Note[]): number {
  if (notes.length === 0) return 0;
  const mtimes = notes.map((n) => n.mtimeMs);
  const minMs = Math.min(...mtimes);
  const maxMs = Math.max(...mtimes);
  const spanDays = Math.ceil((maxMs - minMs) / MS_PER_DAY) + 1;
  if (spanDays <= 1) return 1.0; // only one day in span

  // Build set of UTC day strings covered by note mtimes
  const coveredDays = new Set<string>();
  for (const n of notes) {
    const d = new Date(n.mtimeMs);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    coveredDays.add(key);
  }
  return Math.min(1.0, coveredDays.size / spanDays);
}

/**
 * revisions_per_note — mean distinct mtime-days per note.
 * Without git history, each note has 1 distinct mtime-day (v1 approximation).
 * Preserved as a named observable for future enhancement without changing
 * the calling code.
 */
export function revisionsPerNote(notes: Note[]): number {
  if (notes.length === 0) return 0;
  const total = notes.reduce((s, n) => s + mtimeDaysForNote(n), 0);
  return total / notes.length;
}

/**
 * link_density — mean outbound wikilinks per note.
 */
export function linkDensity(notes: Note[]): number {
  if (notes.length === 0) return 0;
  return notes.reduce((s, n) => s + n.outboundLinks.length, 0) / notes.length;
}

/**
 * backlink_ratio — fraction of notes that are linked-to by ≥1 other note.
 * Computes "inbound link count" from the outboundLinks arrays.
 */
export function backlinkRatio(notes: Note[]): number {
  if (notes.length === 0) return 0;

  // Build set of all note paths for membership testing
  const pathSet = new Set(notes.map((n) => n.path));

  // Count how many notes are targeted by at least one outbound link
  const linkedTo = new Set<string>();
  for (const n of notes) {
    for (const target of n.outboundLinks) {
      if (pathSet.has(target)) {
        linkedTo.add(target);
      }
    }
  }
  return linkedTo.size / notes.length;
}

/**
 * orphan_ratio — fraction of notes with zero in-links AND zero out-links.
 */
export function orphanRatio(notes: Note[]): number {
  if (notes.length === 0) return 0;

  const pathSet = new Set(notes.map((n) => n.path));
  const hasInbound = new Set<string>();
  for (const n of notes) {
    for (const target of n.outboundLinks) {
      if (pathSet.has(target)) hasInbound.add(target);
    }
  }
  const orphanCount = notes.filter(
    (n) => n.outboundLinks.length === 0 && !hasInbound.has(n.path),
  ).length;
  return orphanCount / notes.length;
}

/**
 * concept_note_ratio — fraction of notes that are "atomic/MOC" style:
 * shorter than P25 length AND have more outbound links than the median
 * link density. Resists naive bulk-paste (short + densely-linked is a
 * structural pattern, not a content-length trick).
 */
export function conceptNoteRatio(notes: Note[]): number {
  if (notes.length === 0) return 0;
  const p25 = p25NoteLen(notes);
  const medLD = medianLinkDensity(notes);
  const count = notes.filter(
    (n) => n.contentLength < p25 && n.outboundLinks.length > medLD,
  ).length;
  return count / notes.length;
}

/**
 * distinct_tags — count of unique tag strings (without #).
 */
export function distinctTags(notes: Note[]): number {
  const s = new Set<string>();
  for (const n of notes) {
    for (const t of n.tags) s.add(t);
  }
  return s.size;
}

/**
 * tag_ns_depth — mean nesting depth of #a/b/c style tags.
 * Depth of "a" = 1, "a/b" = 2, etc.
 */
export function tagNsDepth(notes: Note[]): number {
  const allTags: string[] = [];
  for (const n of notes) {
    for (const t of n.tags) allTags.push(t);
  }
  if (allTags.length === 0) return 0;
  const totalDepth = allTags.reduce((s, t) => s + (t.split("/").length), 0);
  return totalDepth / allTags.length;
}

/**
 * distinct_folders — count of unique vault folders (at any depth) present.
 */
export function distinctFolders(notes: Note[]): number {
  const s = new Set(notes.map((n) => n.folder));
  return s.size;
}

/**
 * folder_depth — mean depth of note paths (number of "/" separators + 1).
 * Root-level notes have depth 1.
 */
export function folderDepth(notes: Note[]): number {
  if (notes.length === 0) return 0;
  const total = notes.reduce((s, n) => {
    const depth = n.folder === "" ? 1 : n.folder.split("/").length + 1;
    return s + depth;
  }, 0);
  return total / notes.length;
}

/**
 * topical_entropy — Shannon entropy over the top-level tag/folder namespace.
 *
 * Top-level namespace of a note = first segment of its folder path or first
 * tag (whichever provides more signal). We use folder top-level as the
 * primary namespace (if non-root) and fall back to first tag top-level.
 * Entropy is maximised when notes are spread evenly over many namespaces.
 */
export function topicalEntropy(notes: Note[]): number {
  if (notes.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const n of notes) {
    let ns: string;
    if (n.folder !== "") {
      ns = n.folder.split("/")[0] ?? "root";
    } else if (n.tags.length > 0) {
      ns = (n.tags[0] ?? "untagged").split("/")[0] ?? "untagged";
    } else {
      ns = "root";
    }
    counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }

  const total = notes.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * template_adherence — fraction of notes that share a recurring frontmatter
 * shape (at least 2 shared frontmatter keys also present in ≥50% of notes).
 * Structural proxy for systematic organisation.
 */
export function templateAdherence(notes: Note[]): number {
  if (notes.length === 0) return 0;

  // Count occurrences of each frontmatter key
  const keyCounts = new Map<string, number>();
  for (const n of notes) {
    for (const k of Object.keys(n.frontmatter)) {
      keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
    }
  }

  // Template keys = those appearing in ≥50% of notes
  const threshold = notes.length * 0.5;
  const templateKeys = new Set<string>();
  for (const [k, c] of keyCounts) {
    if (c >= threshold) templateKeys.add(k);
  }

  if (templateKeys.size < 2) return 0; // no consistent template structure

  // A note matches the template if it has ALL template keys
  const matching = notes.filter((n) => {
    for (const k of templateKeys) {
      if (!(k in n.frontmatter)) return false;
    }
    return true;
  }).length;

  return matching / notes.length;
}

/**
 * lexical_diversity — type-token ratio over a deterministic sample.
 *
 * LLM-free, no semantic reading. We proxy lexical diversity from note paths
 * and tag vocabularies rather than note content (which would require
 * reading/parsing prose). This measures structural lexical diversity —
 * how varied the naming/tagging vocabulary is — not prose richness.
 *
 * Deterministic sample: all note filename stems + all tag segments, sorted
 * and deduplicated at the type level. TTR = types / tokens.
 *
 * Note: this is a structural approximation. A future revision may use
 * content if the adapter provides word-level stats without a model.
 */
export function lexicalDiversity(notes: Note[]): number {
  if (notes.length === 0) return 0;

  const tokens: string[] = [];
  for (const n of notes) {
    // Filename stem (lowercase)
    const stem = n.path.split("/").pop()?.replace(/\.md$/i, "").toLowerCase() ?? "";
    if (stem) tokens.push(stem);
    // Each tag segment
    for (const tag of n.tags) {
      for (const seg of tag.split("/")) {
        const s = seg.toLowerCase().trim();
        if (s) tokens.push(s);
      }
    }
  }
  if (tokens.length === 0) return 0;
  const types = new Set(tokens).size;
  return types / tokens.length;
}

/**
 * reading_note_volume — note count (pass-through; used when filtering
 * to the reading-note subtag before calling).
 */
export function readingNoteVolume(notes: Note[]): number {
  return notes.length;
}

/**
 * external_ref_density — external (http/https) links per note.
 * Computed from outboundLinks that start with "http".
 */
export function externalRefDensity(notes: Note[]): number {
  if (notes.length === 0) return 0;
  const total = notes.reduce((s, n) => {
    const ext = n.outboundLinks.filter((l) =>
      l.startsWith("http://") || l.startsWith("https://"),
    ).length;
    return s + ext;
  }, 0);
  return total / notes.length;
}

/**
 * namespace_entry_cadence — rate of first-appearance of new top-level
 * namespaces per active_month. Higher = exploring new areas more often.
 */
export function namespaceEntryCadence(notes: Note[]): number {
  const months = activeMonths(notes);
  if (months <= 0 || notes.length === 0) return 0;

  // Sort notes by mtime ascending
  const sorted = [...notes].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const seen = new Set<string>();
  let newEntries = 0;

  for (const n of sorted) {
    const ns = n.folder !== "" ? (n.folder.split("/")[0] ?? "root") : "root";
    if (!seen.has(ns)) {
      seen.add(ns);
      newEntries++;
    }
  }

  return newEntries / months;
}

/**
 * namespace_concentration — Herfindahl-Hirschman Index over namespace
 * note-shares. Higher = more concentrated (deep in few namespaces).
 * HHI ∈ [1/n, 1] where n is number of namespaces.
 */
export function namespaceConcentration(notes: Note[]): number {
  if (notes.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const n of notes) {
    const ns = n.folder !== "" ? (n.folder.split("/")[0] ?? "root") : "root";
    counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }

  const total = notes.length;
  let hhi = 0;
  for (const c of counts.values()) {
    const share = c / total;
    hhi += share * share;
  }
  return hhi;
}

/**
 * note_growth_per_month — notes added per active month.
 * (note_count / active_months, floor at 0.)
 */
export function noteGrowthPerMonth(notes: Note[]): number {
  const months = activeMonths(notes);
  if (months <= 0) return notes.length; // all in one month → count as itself
  return notes.length / months;
}

/**
 * cross_folder_link_rate — fraction of outbound wikilinks that target
 * a note in a DIFFERENT top-level folder than the source note.
 * Proxy for cross-domain connection-making.
 */
export function crossFolderLinkRate(notes: Note[]): number {
  if (notes.length === 0) return 0;

  // Build path → folder map
  const pathToFolder = new Map<string, string>();
  for (const n of notes) {
    pathToFolder.set(n.path, n.folder.split("/")[0] ?? "root");
  }

  let totalLinks = 0;
  let crossFolderLinks = 0;

  for (const n of notes) {
    const srcNs = n.folder.split("/")[0] ?? "root";
    for (const target of n.outboundLinks) {
      totalLinks++;
      const targetNs = pathToFolder.get(target);
      if (targetNs !== undefined && targetNs !== srcNs) {
        crossFolderLinks++;
      }
    }
  }

  return totalLinks === 0 ? 0 : crossFolderLinks / totalLinks;
}

/**
 * long_freeform_note_share — fraction of notes whose length exceeds
 * 2× the mean note length. Proxy for exploratory/intuitive writing style.
 */
export function longFreeformNoteShare(notes: Note[]): number {
  if (notes.length === 0) return 0;
  const mean = meanNoteLen(notes);
  if (mean === 0) return 0;
  return notes.filter((n) => n.contentLength > 2 * mean).length / notes.length;
}

/**
 * distinct_namespaces — count of distinct top-level namespaces.
 * A namespace is the first segment of a note's folder path (or "root").
 */
export function distinctNamespaces(notes: Note[]): number {
  const s = new Set<string>();
  for (const n of notes) {
    const ns = n.folder !== "" ? (n.folder.split("/")[0] ?? "root") : "root";
    s.add(ns);
  }
  return s.size;
}
