/**
 * vault-trait-engine/engine.ts
 *
 * Host-agnostic pure engine: `deriveInferencesForSubtag(subtag, notes[]) → TraitSignal[]`
 *
 * Implements:
 *   §2  observables (via ./observables)
 *   §3  mapping table — signal weights + per-trait gates as named constants
 *   §4  confidence model (floor 0.15, linear interpolation, hard cap 0.30)
 *   §5  gating (universal floor + per-trait gates; silence not 0.0)
 *   §6  hard exclusions (affect/emotion family + interpersonal/pressure traits)
 *   §7  wire shape
 *
 * LLM-free, stdlib-only. No I/O, no network, no model, no keyword lists.
 */

import { createHash } from "node:crypto";
import type { MethodAudit, Note, TraitSignal, VaultSubtag } from "./types.js";
import {
  CONFIDENCE_CAP,
  CONFIDENCE_FLOOR,
  interpolateConfidence,
  sigmoidNorm,
  sigmoidSoftmax,
  toWireValue,
} from "./math.js";
import {
  activeMonths,
  activeSpanDays,
  backlinkRatio,
  conceptNoteRatio,
  crossFolderLinkRate,
  dailyCoverage,
  distinctNamespaces,
  distinctTags,
  externalRefDensity,
  folderDepth,
  linkDensity,
  longFreeformNoteShare,
  namespaceConcentration,
  namespaceEntryCadence,
  noteGrowthPerMonth,
  orphanRatio,
  readingNoteVolume,
  revisionsPerNote,
  tagNsDepth,
  templateAdherence,
  topicalEntropy,
} from "./observables.js";

// ---------------------------------------------------------------------------
// Hard exclusion lists (§6) — NEVER computed, NEVER emitted
// ---------------------------------------------------------------------------

/**
 * §6: Affect/emotion family — EU AI Act Art 5(1)(d) deny-list.
 * The engine never computes or emits these.
 */
const AFFECT_EMOTION_EXCLUDED = new Set([
  "emotional_stability",
  "affect_regulation",
  "emotional_expression",
  "emotional_reactivity",
  "positive_affect",
  "negative_affect",
  "mood_regulation",
  "empathy",
  "emotional_intelligence",
  // broader affect family
  "anxiety",
  "neuroticism",
  "agreeableness_affect",
]);

/**
 * §6: Interpersonal/pressure traits — excluded; static vault carries
 * no credible signal for these.
 */
const INTERPERSONAL_PRESSURE_EXCLUDED = new Set([
  "pressure_response",
  "recovery_velocity",
  "dissent_courage",
  "vulnerability_capacity",
  "conviction_stability",
]);

/** Union of all hard-excluded trait names. */
export const HARD_EXCLUDED_TRAITS: ReadonlySet<string> = new Set([
  ...AFFECT_EMOTION_EXCLUDED,
  ...INTERPERSONAL_PRESSURE_EXCLUDED,
]);

// ---------------------------------------------------------------------------
// Sink-accepted trait allow-list (defence-in-depth emit-filter)
// ---------------------------------------------------------------------------

/**
 * The backend `vault_ingest` MCP tool's currently-accepted trait names —
 * the intersection of MemberTraitVector trait columns AND CONTINUOUS_TRAITS
 * in the backend trait_merger that the sink will accept without rejecting.
 *
 * This constant is consumed by the egress-layer `filterToSinkAccepted()` helper
 * (see below). It is defence-in-depth: the daemonless plugin must never POST a
 * trait the `vault_ingest` MCP tool would reject. The filter lives OUTSIDE
 * `deriveInferencesForSubtag` so the pure engine stays testable for all traits;
 * the future daemonless POST path applies `filterToSinkAccepted()` to engine
 * output before sending to the backend.
 *
 * THE SET EXPANDS AS THE BACKEND RECONCILE LANDS. Pending backend acceptance
 * (7 traits — suppressed at egress only, fully derived by the engine):
 *   cross_discipline_index, scholarship_breadth, reflective_orientation,
 *   processing_mode_systematic, processing_mode_intuitive,
 *   core_motivator_mastery, core_motivator_novelty.
 * When the backend reconcile ships, add those names here and re-ship the plugin.
 */
export const SINK_ACCEPTED_TRAITS: ReadonlySet<string> = new Set([
  "abstraction_comfort",
  "learning_velocity",
  "pattern_recognition",
]);

// ---------------------------------------------------------------------------
// Universal floor gates (§5)
// ---------------------------------------------------------------------------

/** Minimum note count for any emission. */
const UNIVERSAL_MIN_NOTES = 20;
/** Minimum active span in days for any emission. */
const UNIVERSAL_MIN_SPAN_DAYS = 14;

// ---------------------------------------------------------------------------
// §3 Calibration bands (min, max) for sigmoidNorm per observable.
// These define the [0, 1] output range for each raw observable.
// Calibration: band min ≈ sparse/gate-just-met; band max ≈ dense/saturated.
// Inline comments document the reasoning and calibration basis.
// ---------------------------------------------------------------------------

/** revisions_per_note: [1, 3] — 1 = no revisions, 3 = heavily revised */
const BAND_REVISIONS_PER_NOTE: [number, number] = [1.0, 3.0];
/** daily_coverage: [0, 0.6] — 0 = no daily notes, 0.6 = active 60% of days */
const BAND_DAILY_COVERAGE: [number, number] = [0.0, 0.6];
/** concept_note_ratio: [0, 0.4] — 0 = no atomic notes, 0.4 = 40% atomic */
const BAND_CONCEPT_NOTE_RATIO: [number, number] = [0.0, 0.4];
/** link_density: [0, 5] — 0 = no links, 5 = avg 5 links/note */
const BAND_LINK_DENSITY: [number, number] = [0.0, 5.0];
/** tag_ns_depth: [1, 3] — 1 = flat tags, 3 = deeply nested hierarchy */
const BAND_TAG_NS_DEPTH: [number, number] = [1.0, 3.0];
/** note_growth_per_month: [1, 20] — 1 = 1 note/month, 20 = active learner */
const BAND_NOTE_GROWTH_PER_MONTH: [number, number] = [1.0, 20.0];
/** reading_note_volume: [10, 100] — 10 = gate minimum, 100 = avid reader */
const BAND_READING_NOTE_VOLUME: [number, number] = [10.0, 100.0];
/** backlink_ratio: [0, 0.5] — 0 = isolated notes, 0.5 = well-connected */
const BAND_BACKLINK_RATIO: [number, number] = [0.0, 0.5];
/** cross_folder_link_rate: [0, 0.3] — 0 = siloed, 0.3 = cross-domain links */
const BAND_CROSS_FOLDER_LINK_RATE: [number, number] = [0.0, 0.3];
/** topical_entropy: [0, 3] — 0 = all in one namespace, 3 = highly distributed */
const BAND_TOPICAL_ENTROPY: [number, number] = [0.0, 3.0];
/** external_ref_density: [0, 5] — 0 = no external links, 5 = avg 5 per note */
const BAND_EXTERNAL_REF_DENSITY: [number, number] = [0.0, 5.0];
/** template_adherence: [0, 0.8] — 0 = no template, 0.8 = highly templated */
const BAND_TEMPLATE_ADHERENCE: [number, number] = [0.0, 0.8];
/** folder_depth: [1, 4] — 1 = flat vault, 4 = deeply nested */
const BAND_FOLDER_DEPTH: [number, number] = [1.0, 4.0];
/** orphan_ratio: [0, 0.8] — 0 = all connected, 0.8 = mostly orphaned */
const BAND_ORPHAN_RATIO: [number, number] = [0.0, 0.8];
/** long_freeform_note_share: [0, 0.4] — 0 = no long notes, 0.4 = 40% long */
const BAND_LONG_FREEFORM_NOTE_SHARE: [number, number] = [0.0, 0.4];
/**
 * namespace_concentration (HHI): [0.05, 1.0] — 0.05 = highly distributed
 * (mastery ← depth in few namespaces → higher HHI)
 */
const BAND_NAMESPACE_CONCENTRATION: [number, number] = [0.05, 1.0];
/**
 * namespace_entry_cadence: [0, 3] — 0 = never explored new areas,
 * 3 = 3 new namespaces per month (novelty ← breadth-over-time)
 */
const BAND_NAMESPACE_ENTRY_CADENCE: [number, number] = [0.0, 3.0];

// ---------------------------------------------------------------------------
// §4 Confidence density gates for interpolation
// Tuple: [densityGateMin, densityStrongMax] per trait.
// Gate-min matches the per-trait note-count gate; strong-max is the
// "well above gate, clear signal" density.
// ---------------------------------------------------------------------------

/** [gate-min notes, strong-max notes] for primary-driver density interpolation */
const CONFIDENCE_DENSITY_reflective_orientation: [number, number] = [20, 100];
const CONFIDENCE_DENSITY_abstraction_comfort: [number, number] = [30, 150];
const CONFIDENCE_DENSITY_learning_velocity: [number, number] = [20, 120];
const CONFIDENCE_DENSITY_pattern_recognition: [number, number] = [30, 150];
const CONFIDENCE_DENSITY_cross_discipline_index: [number, number] = [20, 100];
const CONFIDENCE_DENSITY_scholarship_breadth: [number, number] = [10, 80];
const CONFIDENCE_DENSITY_processing_mode: [number, number] = [30, 200];
const CONFIDENCE_DENSITY_core_motivator: [number, number] = [20, 120];

// ---------------------------------------------------------------------------
// Digest helper
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of the aggregate of contributing note paths + lengths. */
function aggregateDigest(notes: Note[]): string {
  const h = createHash("sha256");
  // Sort for determinism; use path + contentLength as a stable fingerprint
  const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path));
  for (const n of sorted) {
    h.update(`${n.path}:${n.contentLength}:${n.mtimeMs}`, "utf8");
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// TraitSignal builder helpers
// ---------------------------------------------------------------------------

function makeSignal(
  traitName: string,
  wireValue: number,
  confidence: number,
  streamSubtag: string,
  sourceDigest: string,
  methodAudit: MethodAudit,
): TraitSignal {
  // Assert not in hard-excluded set (should never reach here if gates are correct)
  if (HARD_EXCLUDED_TRAITS.has(traitName)) {
    throw new Error(`HARD EXCLUSION violated: attempted to emit ${traitName}`);
  }
  return {
    trait_name: traitName,
    value: toWireValue(wireValue),
    confidence: Math.min(CONFIDENCE_CAP, Math.max(CONFIDENCE_FLOOR, confidence)),
    provenance_class: "passive_local_document",
    stream_subtag: streamSubtag,
    source_digest: sourceDigest,
    method_audit: methodAudit,
  };
}

// ---------------------------------------------------------------------------
// §3 Trait derivation functions
// ---------------------------------------------------------------------------

/**
 * reflective_orientation
 * Gate: ≥20 notes, ≥30d span
 * Drivers: revisions_per_note (0.55), daily_coverage (0.30), concept_note_ratio (0.15)
 */
function deriveReflectiveOrientation(
  notes: Note[],
  subtag: string,
  digest: string,
): TraitSignal | null {
  if (notes.length < 20) return null;
  if (activeSpanDays(notes) < 30) return null;

  const rpn = revisionsPerNote(notes);
  const dc = dailyCoverage(notes);
  const cnr = conceptNoteRatio(notes);

  const w_rpn = sigmoidNorm(rpn, BAND_REVISIONS_PER_NOTE);
  const w_dc = sigmoidNorm(dc, BAND_DAILY_COVERAGE);
  const w_cnr = sigmoidNorm(cnr, BAND_CONCEPT_NOTE_RATIO);

  const raw = 0.55 * w_rpn + 0.30 * w_dc + 0.15 * w_cnr;
  const confidence = interpolateConfidence(
    notes.length,
    ...CONFIDENCE_DENSITY_reflective_orientation,
  );

  return makeSignal(
    "reflective_orientation",
    raw,
    confidence,
    subtag,
    digest,
    {
      observables: {
        revisions_per_note: rpn,
        daily_coverage: dc,
        concept_note_ratio: cnr,
      },
      weighted_raw: raw,
      transform: "sigmoid",
      calibration_band: [0, 1],
    },
  );
}

/**
 * abstraction_comfort
 * Gate: ≥30 notes, ≥1 tag namespace
 * Drivers: concept_note_ratio (0.45), link_density (0.30), tag_ns_depth (0.25)
 */
function deriveAbstractionComfort(
  notes: Note[],
  subtag: string,
  digest: string,
): TraitSignal | null {
  if (notes.length < 30) return null;
  if (distinctTags(notes) === 0) return null; // no tag namespace

  const cnr = conceptNoteRatio(notes);
  const ld = linkDensity(notes);
  const tnd = tagNsDepth(notes);

  const w_cnr = sigmoidNorm(cnr, BAND_CONCEPT_NOTE_RATIO);
  const w_ld = sigmoidNorm(ld, BAND_LINK_DENSITY);
  const w_tnd = sigmoidNorm(tnd, BAND_TAG_NS_DEPTH);

  const raw = 0.45 * w_cnr + 0.30 * w_ld + 0.25 * w_tnd;
  const confidence = interpolateConfidence(
    notes.length,
    ...CONFIDENCE_DENSITY_abstraction_comfort,
  );

  return makeSignal(
    "abstraction_comfort",
    raw,
    confidence,
    subtag,
    digest,
    {
      observables: {
        concept_note_ratio: cnr,
        link_density: ld,
        tag_ns_depth: tnd,
      },
      weighted_raw: raw,
      transform: "sigmoid",
      calibration_band: [0, 1],
    },
  );
}

/**
 * learning_velocity
 * Gate: ≥3 active months
 * Drivers: note_growth_per_month (0.6), reading_note_volume_trend (0.4)
 *
 * NOTE: reading_note_volume_trend is approximated as the raw reading volume
 * normalised to the active span — a full time-series trend requires history
 * the vault API doesn't expose in v1. The approximation is structural and
 * LLM-free. Flagged for calibration refinement when richer mtime history
 * is available.
 */
function deriveLearningVelocity(
  notes: Note[],
  readingNotes: Note[],
  subtag: string,
  digest: string,
): TraitSignal | null {
  const months = activeMonths(notes);
  if (months < 3) return null;

  const growth = noteGrowthPerMonth(notes);
  const rnv = readingNoteVolume(readingNotes);

  const w_growth = sigmoidNorm(growth, BAND_NOTE_GROWTH_PER_MONTH);
  const w_rnv = sigmoidNorm(rnv, BAND_READING_NOTE_VOLUME);

  const raw = 0.6 * w_growth + 0.4 * w_rnv;
  const confidence = interpolateConfidence(
    notes.length,
    ...CONFIDENCE_DENSITY_learning_velocity,
  );

  return makeSignal(
    "learning_velocity",
    raw,
    confidence,
    subtag,
    digest,
    {
      observables: {
        note_growth_per_month: growth,
        reading_note_volume: rnv,
        active_months: months,
      },
      weighted_raw: raw,
      transform: "sigmoid",
      calibration_band: [0, 1],
    },
  );
}

/**
 * pattern_recognition
 * Gate: ≥30 notes, ≥1 backlink
 * Drivers: backlink_ratio (0.5), cross_folder_link_rate (0.3), link_density (0.2)
 */
function derivePatternRecognition(
  notes: Note[],
  subtag: string,
  digest: string,
): TraitSignal | null {
  if (notes.length < 30) return null;
  if (backlinkRatio(notes) === 0) return null; // no backlinks present

  const br = backlinkRatio(notes);
  const cflr = crossFolderLinkRate(notes);
  const ld = linkDensity(notes);

  const w_br = sigmoidNorm(br, BAND_BACKLINK_RATIO);
  const w_cflr = sigmoidNorm(cflr, BAND_CROSS_FOLDER_LINK_RATE);
  const w_ld = sigmoidNorm(ld, BAND_LINK_DENSITY);

  const raw = 0.5 * w_br + 0.3 * w_cflr + 0.2 * w_ld;
  const confidence = interpolateConfidence(
    notes.length,
    ...CONFIDENCE_DENSITY_pattern_recognition,
  );

  return makeSignal(
    "pattern_recognition",
    raw,
    confidence,
    subtag,
    digest,
    {
      observables: {
        backlink_ratio: br,
        cross_folder_link_rate: cflr,
        link_density: ld,
      },
      weighted_raw: raw,
      transform: "sigmoid",
      calibration_band: [0, 1],
    },
  );
}

/**
 * cross_discipline_index
 * Gate: ≥3 distinct namespaces
 * Driver: topical_entropy (1.0)
 */
function deriveCrossDisciplineIndex(
  notes: Note[],
  subtag: string,
  digest: string,
): TraitSignal | null {
  if (distinctNamespaces(notes) < 3) return null;

  const te = topicalEntropy(notes);
  const raw = sigmoidNorm(te, BAND_TOPICAL_ENTROPY);
  const confidence = interpolateConfidence(
    notes.length,
    ...CONFIDENCE_DENSITY_cross_discipline_index,
  );

  return makeSignal(
    "cross_discipline_index",
    raw,
    confidence,
    subtag,
    digest,
    {
      observables: { topical_entropy: te },
      weighted_raw: raw,
      transform: "sigmoid",
      calibration_band: BAND_TOPICAL_ENTROPY,
    },
  );
}

/**
 * scholarship_breadth
 * Gate: reading-note subtag present, ≥10 reading notes
 * Drivers: reading_note_volume (0.5), external_ref_density (0.5)
 */
function deriveScholarshipBreadth(
  readingNotes: Note[],
  subtag: string,
  digest: string,
): TraitSignal | null {
  if (readingNotes.length < 10) return null;

  const rnv = readingNotes.length;
  const erd = externalRefDensity(readingNotes);

  const w_rnv = sigmoidNorm(rnv, BAND_READING_NOTE_VOLUME);
  const w_erd = sigmoidNorm(erd, BAND_EXTERNAL_REF_DENSITY);

  const raw = 0.5 * w_rnv + 0.5 * w_erd;
  const confidence = interpolateConfidence(
    readingNotes.length,
    ...CONFIDENCE_DENSITY_scholarship_breadth,
  );

  return makeSignal(
    "scholarship_breadth",
    raw,
    confidence,
    subtag,
    digest,
    {
      observables: {
        reading_note_volume: rnv,
        external_ref_density: erd,
      },
      weighted_raw: raw,
      transform: "sigmoid",
      calibration_band: [0, 1],
    },
  );
}

/**
 * processing_mode_systematic + processing_mode_intuitive (softmax pair)
 * Gate: ≥30 notes
 * systematic ← template_adherence (0.5) + folder_depth (0.3) + tag_ns_depth (0.2)
 * intuitive ← orphan_ratio (0.5) + long_freeform_note_share (0.5)
 *
 * Pre-softmax raws are in [0,1]; sigmoid-then-softmax forces the trade-off.
 * Both emitted as named [0,1] scores (unipolar per value convention).
 */
function deriveProcessingMode(
  notes: Note[],
  subtag: string,
  digest: string,
): [TraitSignal, TraitSignal] | null {
  if (notes.length < 30) return null;

  const ta = templateAdherence(notes);
  const fd = folderDepth(notes);
  const tnd = tagNsDepth(notes);
  const or_ = orphanRatio(notes);
  const lfns = longFreeformNoteShare(notes);

  const sysRaw =
    0.5 * sigmoidNorm(ta, BAND_TEMPLATE_ADHERENCE) +
    0.3 * sigmoidNorm(fd, BAND_FOLDER_DEPTH) +
    0.2 * sigmoidNorm(tnd, BAND_TAG_NS_DEPTH);

  const intRaw =
    0.5 * sigmoidNorm(or_, BAND_ORPHAN_RATIO) +
    0.5 * sigmoidNorm(lfns, BAND_LONG_FREEFORM_NOTE_SHARE);

  const [sysScore, intScore] = sigmoidSoftmax([sysRaw, intRaw]);

  const confidence = interpolateConfidence(
    notes.length,
    ...CONFIDENCE_DENSITY_processing_mode,
  );

  const sysSignal = makeSignal(
    "processing_mode_systematic",
    sysScore ?? 0,
    confidence,
    subtag,
    digest,
    {
      observables: {
        template_adherence: ta,
        folder_depth: fd,
        tag_ns_depth: tnd,
        pre_softmax_systematic_raw: sysRaw,
      },
      weighted_raw: sysRaw,
      transform: "sigmoid_softmax",
      calibration_band: [0, 1],
    },
  );

  const intSignal = makeSignal(
    "processing_mode_intuitive",
    intScore ?? 0,
    confidence,
    subtag,
    digest,
    {
      observables: {
        orphan_ratio: or_,
        long_freeform_note_share: lfns,
        pre_softmax_intuitive_raw: intRaw,
      },
      weighted_raw: intRaw,
      transform: "sigmoid_softmax",
      calibration_band: [0, 1],
    },
  );

  return [sysSignal, intSignal];
}

/**
 * core_motivator_mastery + core_motivator_novelty (softmax pair)
 * Gate: ≥3 active months, ≥3 namespaces
 * mastery ← namespace_concentration (depth in few namespaces → high HHI)
 * novelty ← namespace_entry_cadence (breadth-over-time)
 *
 * Pre-normalised against the full 7-way motivator space so the
 * merger can blend without double-counting. The 5 other motivators come from
 * git-based signal streams on the backend. We emit only these two from vault.
 */
function deriveCoreMotivators(
  notes: Note[],
  subtag: string,
  digest: string,
): [TraitSignal, TraitSignal] | null {
  const months = activeMonths(notes);
  if (months < 3) return null;
  if (distinctNamespaces(notes) < 3) return null;

  const nc = namespaceConcentration(notes);
  const nec = namespaceEntryCadence(notes);

  const masteryRaw = sigmoidNorm(nc, BAND_NAMESPACE_CONCENTRATION);
  const noveltyRaw = sigmoidNorm(nec, BAND_NAMESPACE_ENTRY_CADENCE);

  // sigmoid-then-softmax over the pair (mirrors the backend's mechanic)
  const [masteryScore, noveltyScore] = sigmoidSoftmax([masteryRaw, noveltyRaw]);

  const confidence = interpolateConfidence(
    notes.length,
    ...CONFIDENCE_DENSITY_core_motivator,
  );

  const masterySignal = makeSignal(
    "core_motivator_mastery",
    masteryScore ?? 0,
    confidence,
    subtag,
    digest,
    {
      observables: {
        namespace_concentration_hhi: nc,
        pre_softmax_mastery_raw: masteryRaw,
      },
      weighted_raw: masteryRaw,
      transform: "sigmoid_softmax",
      calibration_band: BAND_NAMESPACE_CONCENTRATION,
    },
  );

  const noveltySignal = makeSignal(
    "core_motivator_novelty",
    noveltyScore ?? 0,
    confidence,
    subtag,
    digest,
    {
      observables: {
        namespace_entry_cadence: nec,
        pre_softmax_novelty_raw: noveltyRaw,
      },
      weighted_raw: noveltyRaw,
      transform: "sigmoid_softmax",
      calibration_band: BAND_NAMESPACE_ENTRY_CADENCE,
    },
  );

  return [masterySignal, noveltySignal];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Derive trait inferences for a single vault subtag.
 *
 * Pure function — no I/O, no network, no model.
 *
 * @param subtag   The vault subtag being processed (e.g. "manual-note").
 * @param notes    Notes belonging to this subtag (host-agnostic Note[]).
 * @param readingNotes  Notes from the "reading-note" subtag (may be empty if
 *                 not available; only affects learning_velocity and
 *                 scholarship_breadth).
 * @returns        Array of TraitSignal — may be empty if gates fail.
 */
export function deriveInferencesForSubtag(
  subtag: VaultSubtag | string,
  notes: Note[],
  readingNotes: Note[] = [],
): TraitSignal[] {
  // §5 Universal floor: emit nothing from sparse vaults
  if (notes.length < UNIVERSAL_MIN_NOTES) return [];
  if (activeSpanDays(notes) < UNIVERSAL_MIN_SPAN_DAYS) return [];

  const streamSubtag = `obsidian-vault/${subtag}`;
  const digest = aggregateDigest(notes);
  const results: TraitSignal[] = [];

  // §3 Trait derivations — per-trait gates inside each function
  const reflective = deriveReflectiveOrientation(notes, streamSubtag, digest);
  if (reflective) results.push(reflective);

  const abstraction = deriveAbstractionComfort(notes, streamSubtag, digest);
  if (abstraction) results.push(abstraction);

  const velocity = deriveLearningVelocity(notes, readingNotes, streamSubtag, digest);
  if (velocity) results.push(velocity);

  const pattern = derivePatternRecognition(notes, streamSubtag, digest);
  if (pattern) results.push(pattern);

  const crossDisc = deriveCrossDisciplineIndex(notes, streamSubtag, digest);
  if (crossDisc) results.push(crossDisc);

  const scholarship = deriveScholarshipBreadth(readingNotes, streamSubtag, digest);
  if (scholarship) results.push(scholarship);

  const procMode = deriveProcessingMode(notes, streamSubtag, digest);
  if (procMode) results.push(...procMode);

  const motivators = deriveCoreMotivators(notes, streamSubtag, digest);
  if (motivators) results.push(...motivators);

  // Safety: strip any hard-excluded trait that somehow slipped through
  // (defence-in-depth; makeSignal() also throws, so this is belt-and-suspenders)
  const hardFiltered = results.filter((s) => !HARD_EXCLUDED_TRAITS.has(s.trait_name));

  // Pure engine returns ALL derived signals (minus doctrinal affect exclusions above).
  // Sink-egress filtering is the responsibility of the egress layer: call
  // filterToSinkAccepted() on this output before POSTing to the backend.
  return hardFiltered;
}

// ---------------------------------------------------------------------------
// Egress-layer sink-compatibility gate
// ---------------------------------------------------------------------------

/**
 * Egress-layer sink-compatibility gate.
 *
 * The future daemonless POST path applies this to `deriveInferencesForSubtag(...)`
 * output before sending to the backend `vault_ingest` MCP tool. Keeping this
 * separate from derivation means the pure engine is fully testable for all 10
 * traits; the filter is the transport concern, not the derivation concern.
 *
 * Returns only signals whose `trait_name` is in `SINK_ACCEPTED_TRAITS`.
 * Expand `SINK_ACCEPTED_TRAITS` as the backend reconcile lands.
 */
export function filterToSinkAccepted(signals: TraitSignal[]): TraitSignal[] {
  return signals.filter((s) => SINK_ACCEPTED_TRAITS.has(s.trait_name));
}

// Re-export constants useful to tests
export {
  UNIVERSAL_MIN_NOTES,
  UNIVERSAL_MIN_SPAN_DAYS,
  CONFIDENCE_FLOOR,
  CONFIDENCE_CAP,
};

// The 10 canonical trait names emitted by this engine
export const EMITTED_TRAIT_NAMES = [
  "reflective_orientation",
  "abstraction_comfort",
  "learning_velocity",
  "pattern_recognition",
  "cross_discipline_index",
  "scholarship_breadth",
  "processing_mode_systematic",
  "processing_mode_intuitive",
  "core_motivator_mastery",
  "core_motivator_novelty",
] as const;

export type EmittedTraitName = (typeof EMITTED_TRAIT_NAMES)[number];
