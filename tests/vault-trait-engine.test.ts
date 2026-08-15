/**
 * vault-trait-engine tests
 *
 * Coverage:
 *   1. Golden-vault fixtures — deterministic Note[] vaults → asserted signal sets
 *   2. Affect deny-list — no affect/emotion trait ever emitted
 *   3. Sparse-vault no-op — <20 notes and <14d span each → nothing emitted
 *   4. Softmax-sums — processing_mode + core_motivator pairs sum to ~1.0
 *   5. Method-audit reconstructability — each signal carries method_audit
 *      with observables→values→transform
 */

import { describe, expect, it } from "vitest";
import {
  deriveInferencesForSubtag,
  filterToSinkAccepted,
  EMITTED_TRAIT_NAMES,
  HARD_EXCLUDED_TRAITS,
  SINK_ACCEPTED_TRAITS,
} from "../src/vault-trait-engine/engine";
import type { Note } from "../src/vault-trait-engine/types";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const NOW = Date.now();

/** Build a minimal valid Note. */
function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    path: "Notes/untitled.md",
    mtimeMs: NOW,
    ctimeMs: NOW - MS_PER_DAY * 10,
    contentLength: 500,
    frontmatter: {},
    outboundLinks: [],
    tags: [],
    folder: "Notes",
    ...overrides,
  };
}

/**
 * Build a dense, well-connected vault of N notes spanning spanDays days.
 * Notes are spread across `namespaces` top-level folders.
 * Each note has `linksPerNote` outbound links (pointing to other notes in the vault).
 * Tags use nested hierarchy `ns/subtopic`.
 */
function buildDenseVault(opts: {
  n: number;
  spanDays: number;
  namespaces?: number;
  linksPerNote?: number;
  templateFrontmatter?: boolean;
  hasReadingNotes?: boolean;
}): Note[] {
  const {
    n,
    spanDays,
    namespaces = 5,
    linksPerNote = 3,
    templateFrontmatter = true,
    hasReadingNotes: _unused = false,
  } = opts;

  const notes: Note[] = [];
  const baseMs = NOW - spanDays * MS_PER_DAY;

  for (let i = 0; i < n; i++) {
    const nsIdx = i % namespaces;
    const ns = [
      "Projects",
      "Research",
      "Reading",
      "Journal",
      "Reference",
    ][nsIdx % 5] ?? "Notes";
    const path = `${ns}/note-${i}.md`;
    const mtimeMs = baseMs + (i / n) * spanDays * MS_PER_DAY;
    const ctimeMs = baseMs + (i / n) * spanDays * MS_PER_DAY * 0.8;

    // Outbound links: point to nearby notes in the vault
    const outboundLinks: string[] = [];
    for (let j = 1; j <= linksPerNote && i + j < n; j++) {
      const targetNs = [
        "Projects",
        "Research",
        "Reading",
        "Journal",
        "Reference",
      ][(i + j) % 5] ?? "Notes";
      outboundLinks.push(`${targetNs}/note-${i + j}.md`);
    }

    // Some links across namespaces (cross-folder)
    if (i > 0) {
      const crossNs = [
        "Projects",
        "Research",
        "Reading",
        "Journal",
        "Reference",
      ][(nsIdx + 2) % 5] ?? "Notes";
      outboundLinks.push(`${crossNs}/note-${Math.max(0, i - 5)}.md`);
    }

    const tags = [`${ns.toLowerCase()}/topic-${i % 4}`, `${ns.toLowerCase()}/sub`];

    const frontmatter: Record<string, string> = templateFrontmatter
      ? { created: new Date(ctimeMs).toISOString(), status: "active" }
      : {};

    // Vary note length to create concept-note and long-freeform diversity
    let contentLength = 800;
    if (i % 5 === 0) contentLength = 120; // short/atomic
    if (i % 7 === 0) contentLength = 2500; // long freeform

    notes.push({
      path,
      mtimeMs,
      ctimeMs,
      contentLength,
      frontmatter,
      outboundLinks,
      tags,
      folder: ns,
    });
  }

  return notes;
}

/** Build reading notes for learning_velocity and scholarship_breadth. */
function buildReadingNotes(n: number, spanDays: number): Note[] {
  const baseMs = NOW - spanDays * MS_PER_DAY;
  return Array.from({ length: n }, (_, i) => ({
    path: `Reading/reading-note-${i}.md`,
    mtimeMs: baseMs + (i / n) * spanDays * MS_PER_DAY,
    ctimeMs: baseMs + (i / n) * spanDays * MS_PER_DAY * 0.8,
    contentLength: 600,
    frontmatter: { source: `https://example.com/paper-${i}` },
    outboundLinks: [`https://example.com/paper-${i}`],
    tags: ["reading/academic"],
    folder: "Reading",
  }));
}

// ---------------------------------------------------------------------------
// 1. Golden-vault fixtures
// ---------------------------------------------------------------------------

describe("golden-vault: dense 120-note vault spanning 90 days", () => {
  const notes = buildDenseVault({ n: 120, spanDays: 90, namespaces: 5, linksPerNote: 4 });
  const readingNotes = buildReadingNotes(25, 90);
  const allNotes = [...notes, ...readingNotes];
  const result = deriveInferencesForSubtag("manual-note", allNotes, readingNotes);

  it("emits at least 6 signals from a dense vault", () => {
    expect(result.length).toBeGreaterThanOrEqual(6);
  });

  it("emits only known trait names", () => {
    const knownNames = new Set<string>(EMITTED_TRAIT_NAMES);
    for (const signal of result) {
      expect(knownNames.has(signal.trait_name)).toBe(true);
    }
  });

  it("all emitted values are in [0, 1]", () => {
    for (const signal of result) {
      expect(signal.value).toBeGreaterThanOrEqual(0);
      expect(signal.value).toBeLessThanOrEqual(1);
    }
  });

  it("all emitted confidences are in [0.15, 0.30]", () => {
    for (const signal of result) {
      expect(signal.confidence).toBeGreaterThanOrEqual(0.15);
      expect(signal.confidence).toBeLessThanOrEqual(0.30);
    }
  });

  it("all signals carry stream_subtag = obsidian-vault/manual-note", () => {
    for (const signal of result) {
      expect(signal.stream_subtag).toBe("obsidian-vault/manual-note");
    }
  });

  it("all signals carry provenance_class = passive_local_document", () => {
    for (const signal of result) {
      expect(signal.provenance_class).toBe("passive_local_document");
    }
  });

  it("source_digest is a 64-char hex string", () => {
    for (const signal of result) {
      expect(signal.source_digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("emits reflective_orientation (notes ≥20, span ≥30d)", () => {
    const names = result.map((s) => s.trait_name);
    expect(names).toContain("reflective_orientation");
  });

  it("emits cross_discipline_index (≥3 namespaces)", () => {
    const names = result.map((s) => s.trait_name);
    expect(names).toContain("cross_discipline_index");
  });
});

describe("golden-vault: journal subtag", () => {
  const notes = buildDenseVault({ n: 60, spanDays: 120, namespaces: 3 });
  const result = deriveInferencesForSubtag("journal", notes);

  it("emits signals from journal subtag", () => {
    expect(result.length).toBeGreaterThan(0);
  });

  it("stream_subtag is obsidian-vault/journal", () => {
    for (const s of result) {
      expect(s.stream_subtag).toBe("obsidian-vault/journal");
    }
  });
});

describe("golden-vault: reading-note subtag with scholarship gate", () => {
  const readingNotes = buildReadingNotes(20, 60);
  const allNotes = buildDenseVault({ n: 40, spanDays: 90, namespaces: 4 });
  const combined = [...allNotes, ...readingNotes];
  const result = deriveInferencesForSubtag("reading-note", combined, readingNotes);

  it("emits scholarship_breadth when ≥10 reading notes present", () => {
    const names = result.map((s) => s.trait_name);
    expect(names).toContain("scholarship_breadth");
  });
});

// ---------------------------------------------------------------------------
// 2. Affect deny-list
// ---------------------------------------------------------------------------

describe("affect deny-list", () => {
  // Build a vault that could theoretically evoke an affect trait
  const affectProbingNotes = buildDenseVault({
    n: 80,
    spanDays: 120,
    namespaces: 5,
  }).map((n) => ({
    ...n,
    // Inject affect-family words into frontmatter keys to stress-test the gate
    frontmatter: {
      ...n.frontmatter,
      emotional_state: "high",
      mood: "positive",
    },
    tags: [...n.tags, "emotions/regulation", "affect/positive"],
  }));

  const result = deriveInferencesForSubtag("manual-note", affectProbingNotes);

  it("never emits an affect/emotion trait regardless of input", () => {
    for (const signal of result) {
      expect(HARD_EXCLUDED_TRAITS.has(signal.trait_name)).toBe(false);
    }
  });

  it("never emits emotional_stability", () => {
    const names = result.map((s) => s.trait_name);
    expect(names).not.toContain("emotional_stability");
  });

  it("never emits pressure_response", () => {
    const names = result.map((s) => s.trait_name);
    expect(names).not.toContain("pressure_response");
  });

  it("never emits recovery_velocity", () => {
    const names = result.map((s) => s.trait_name);
    expect(names).not.toContain("recovery_velocity");
  });

  it("never emits dissent_courage", () => {
    const names = result.map((s) => s.trait_name);
    expect(names).not.toContain("dissent_courage");
  });

  it("never emits vulnerability_capacity", () => {
    const names = result.map((s) => s.trait_name);
    expect(names).not.toContain("vulnerability_capacity");
  });

  it("never emits conviction_stability", () => {
    const names = result.map((s) => s.trait_name);
    expect(names).not.toContain("conviction_stability");
  });
});

// ---------------------------------------------------------------------------
// 3. Sparse-vault no-op
// ---------------------------------------------------------------------------

describe("sparse-vault: universal floor gates", () => {
  it("emits nothing when note count < 20 (19 notes, long span)", () => {
    const notes = buildDenseVault({ n: 19, spanDays: 90 });
    const result = deriveInferencesForSubtag("manual-note", notes);
    expect(result).toHaveLength(0);
  });

  it("emits nothing when span < 14 days (30 notes, 10-day span)", () => {
    const notes = buildDenseVault({ n: 30, spanDays: 10 });
    const result = deriveInferencesForSubtag("manual-note", notes);
    expect(result).toHaveLength(0);
  });

  it("emits nothing from empty array", () => {
    const result = deriveInferencesForSubtag("manual-note", []);
    expect(result).toHaveLength(0);
  });

  it("emits nothing from a single note", () => {
    const result = deriveInferencesForSubtag("journal", [makeNote()]);
    expect(result).toHaveLength(0);
  });

  it("just-met gate (20 notes, exactly 14d span) may emit or not, but never crashes", () => {
    const notes = buildDenseVault({ n: 20, spanDays: 14 });
    // Just testing it doesn't throw and returns an array
    const result = deriveInferencesForSubtag("manual-note", notes);
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Softmax-sums
// ---------------------------------------------------------------------------

describe("softmax pair sums", () => {
  // Build a vault that clears the softmax gates (≥30 notes, ≥3 months, ≥3 namespaces)
  const notes = buildDenseVault({
    n: 100,
    spanDays: 120,
    namespaces: 5,
    linksPerNote: 3,
  });
  const result = deriveInferencesForSubtag("manual-note", notes);

  it("processing_mode pair sums to ~1.0 (±0.001)", () => {
    const systematic = result.find(
      (s) => s.trait_name === "processing_mode_systematic",
    );
    const intuitive = result.find(
      (s) => s.trait_name === "processing_mode_intuitive",
    );
    if (!systematic || !intuitive) {
      // Both traits must be emitted from a dense vault; fail the test if not
      expect(systematic).toBeDefined();
      expect(intuitive).toBeDefined();
      return;
    }
    const sum = systematic.value + intuitive.value;
    expect(sum).toBeCloseTo(1.0, 3);
  });

  it("core_motivator pair sums to ~1.0 (±0.001) when gates pass", () => {
    const mastery = result.find(
      (s) => s.trait_name === "core_motivator_mastery",
    );
    const novelty = result.find(
      (s) => s.trait_name === "core_motivator_novelty",
    );
    if (!mastery || !novelty) {
      // Skip sum check if gates didn't pass — that's valid behaviour
      return;
    }
    const sum = mastery.value + novelty.value;
    expect(sum).toBeCloseTo(1.0, 3);
  });
});

// ---------------------------------------------------------------------------
// 5. Method-audit reconstructability
// ---------------------------------------------------------------------------

describe("method_audit reconstructability", () => {
  const notes = buildDenseVault({ n: 80, spanDays: 90, namespaces: 5 });
  const result = deriveInferencesForSubtag("manual-note", notes);

  it("every emitted signal carries a method_audit field", () => {
    for (const signal of result) {
      expect(signal.method_audit).toBeDefined();
    }
  });

  it("method_audit.observables is a non-empty object", () => {
    for (const signal of result) {
      expect(typeof signal.method_audit.observables).toBe("object");
      expect(Object.keys(signal.method_audit.observables).length).toBeGreaterThan(0);
    }
  });

  it("method_audit.transform is sigmoid or sigmoid_softmax", () => {
    for (const signal of result) {
      expect(["sigmoid", "sigmoid_softmax"]).toContain(
        signal.method_audit.transform,
      );
    }
  });

  it("method_audit.weighted_raw is a finite number", () => {
    for (const signal of result) {
      expect(Number.isFinite(signal.method_audit.weighted_raw)).toBe(true);
    }
  });

  it("method_audit.calibration_band is a 2-element array", () => {
    for (const signal of result) {
      const band = signal.method_audit.calibration_band;
      expect(Array.isArray(band)).toBe(true);
      expect(band).toHaveLength(2);
    }
  });

  it("observables values are all finite numbers", () => {
    for (const signal of result) {
      for (const [key, val] of Object.entries(signal.method_audit.observables)) {
        expect(Number.isFinite(val), `observable ${key} should be finite`).toBe(
          true,
        );
      }
    }
  });

  it("reflective_orientation audit names expected observables", () => {
    const reflective = result.find(
      (s) => s.trait_name === "reflective_orientation",
    );
    if (!reflective) return; // gate may not fire on this fixture
    const obsKeys = Object.keys(reflective.method_audit.observables);
    expect(obsKeys).toContain("revisions_per_note");
    expect(obsKeys).toContain("daily_coverage");
    expect(obsKeys).toContain("concept_note_ratio");
  });
});

// ---------------------------------------------------------------------------
// 6. LLM-free invariant (static import check)
// ---------------------------------------------------------------------------

describe("LLM-free invariant", () => {
  it("engine module does not import any model/network/lexicon module", async () => {
    // Read the engine source text and check for prohibited imports.
    // This is a static analysis approximation — the actual build test
    // (tsc) will also catch any runtime import violations.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");

    // Use import.meta.url if available (ESM), otherwise __dirname (CJS)
    let engineSource: string;
    try {
      const url = new URL(import.meta.url);
      const dir = dirname(fileURLToPath(url));
      engineSource = readFileSync(
        join(dir, "../src/vault-trait-engine/engine.ts"),
        "utf8",
      );
    } catch {
      engineSource = readFileSync(
        "src/vault-trait-engine/engine.ts",
        "utf8",
      );
    }

    // Prohibited import patterns
    const prohibited = [
      /import.*openai/i,
      /import.*anthropic/i,
      /import.*langchain/i,
      /import.*transformers/i,
      /import.*axios/,
      /import.*node-fetch/,
      /import.*got/,
      /require\(['"]openai/,
      /require\(['"]anthropic/,
    ];

    for (const pattern of prohibited) {
      expect(engineSource).not.toMatch(pattern);
    }
  });

  it("observables module does not import any model/network module", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");

    let obsSource: string;
    try {
      const url = new URL(import.meta.url);
      const dir = dirname(fileURLToPath(url));
      obsSource = readFileSync(
        join(dir, "../src/vault-trait-engine/observables.ts"),
        "utf8",
      );
    } catch {
      obsSource = readFileSync(
        "src/vault-trait-engine/observables.ts",
        "utf8",
      );
    }

    expect(obsSource).not.toMatch(/import.*openai/i);
    expect(obsSource).not.toMatch(/import.*anthropic/i);
    // Check for require() calls — not the word "require" in comments
    expect(obsSource).not.toMatch(/\brequire\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// 7. SINK_ACCEPTED_TRAITS terminal emit-filter
// ---------------------------------------------------------------------------

/**
 * Build a vault rich enough to trigger all 10 traits:
 *   - ≥30 notes, ≥90d span, ≥5 namespaces (cross_discipline_index, processing_mode, core_motivator)
 *   - ≥3 active months (learning_velocity, core_motivator_mastery/novelty)
 *   - outbound links + backlinks (pattern_recognition, abstraction_comfort)
 *   - reading notes (scholarship_breadth, learning_velocity)
 *   - revisions + daily notes (reflective_orientation)
 *
 * This vault is the broadest possible fixture — every per-trait gate is met.
 */
describe("SINK_ACCEPTED_TRAITS egress-layer filter (filterToSinkAccepted)", () => {
  // Vault designed to trigger all 10 traits:
  //   - ≥30 notes, ≥90d span, ≥5 namespaces → cross_discipline_index, processing_mode, core_motivator
  //   - ≥3 active months → learning_velocity, core_motivator gates
  //   - outbound links + backlinks → pattern_recognition, abstraction_comfort
  //   - reading notes → scholarship_breadth, learning_velocity
  //   - revision spread → reflective_orientation
  const allTraitNotes = buildDenseVault({
    n: 150,
    spanDays: 120,
    namespaces: 5,
    linksPerNote: 4,
    templateFrontmatter: true,
  }).map((n, i) => ({
    ...n,
    mtimeMs: n.mtimeMs + (i % 3) * 3_600_000,
    outboundLinks: [
      ...n.outboundLinks,
      i > 0 ? `Notes/note-${Math.max(0, i - 1)}.md` : "Notes/anchor.md",
    ],
  }));
  const richReadingNotes = buildReadingNotes(30, 120);

  // Raw engine output — pure derivation, all traits minus HARD_EXCLUDED_TRAITS
  const rawResult = deriveInferencesForSubtag("manual-note", allTraitNotes, richReadingNotes);
  const rawNames = rawResult.map((s) => s.trait_name);

  // Egress-filtered output — what the daemonless POST path would send
  const filteredResult = filterToSinkAccepted(rawResult);
  const filteredNames = filteredResult.map((s) => s.trait_name);

  // The 7 currently-rejected trait names (pending backend reconcile)
  const PENDING_BACKEND_TRAITS = [
    "cross_discipline_index",
    "scholarship_breadth",
    "reflective_orientation",
    "processing_mode_systematic",
    "processing_mode_intuitive",
    "core_motivator_mastery",
    "core_motivator_novelty",
  ] as const;

  // -- Constant correctness --

  it("SINK_ACCEPTED_TRAITS contains exactly the 3 accepted trait names", () => {
    expect(SINK_ACCEPTED_TRAITS.has("abstraction_comfort")).toBe(true);
    expect(SINK_ACCEPTED_TRAITS.has("learning_velocity")).toBe(true);
    expect(SINK_ACCEPTED_TRAITS.has("pattern_recognition")).toBe(true);
    expect(SINK_ACCEPTED_TRAITS.size).toBe(3);
  });

  it("abstraction_comfort is in SINK_ACCEPTED_TRAITS (protects against typos)", () => {
    expect(SINK_ACCEPTED_TRAITS.has("abstraction_comfort")).toBe(true);
  });

  it("learning_velocity is in SINK_ACCEPTED_TRAITS", () => {
    expect(SINK_ACCEPTED_TRAITS.has("learning_velocity")).toBe(true);
  });

  it("pattern_recognition is in SINK_ACCEPTED_TRAITS", () => {
    expect(SINK_ACCEPTED_TRAITS.has("pattern_recognition")).toBe(true);
  });

  // -- Engine wholeness: unfiltered derivation includes the 7 pending traits --

  it("deriveInferencesForSubtag (unfiltered) derives reflective_orientation from a rich vault", () => {
    expect(rawNames).toContain("reflective_orientation");
  });

  it("deriveInferencesForSubtag (unfiltered) derives cross_discipline_index from a rich vault", () => {
    expect(rawNames).toContain("cross_discipline_index");
  });

  it("deriveInferencesForSubtag (unfiltered) derives scholarship_breadth from a rich vault", () => {
    expect(rawNames).toContain("scholarship_breadth");
  });

  it("deriveInferencesForSubtag (unfiltered) derives at least one processing_mode trait", () => {
    const hasProcMode =
      rawNames.includes("processing_mode_systematic") ||
      rawNames.includes("processing_mode_intuitive");
    expect(hasProcMode).toBe(true);
  });

  // -- Egress filter: filterToSinkAccepted() drops all 7 pending traits --

  it("filterToSinkAccepted() passes at least one accepted trait from a rich vault", () => {
    const acceptedInOutput = filteredNames.filter((n) => SINK_ACCEPTED_TRAITS.has(n));
    expect(acceptedInOutput.length).toBeGreaterThan(0);
  });

  it("filterToSinkAccepted() drops cross_discipline_index (pending backend acceptance)", () => {
    expect(filteredNames).not.toContain("cross_discipline_index");
  });

  it("filterToSinkAccepted() drops scholarship_breadth (pending backend acceptance)", () => {
    expect(filteredNames).not.toContain("scholarship_breadth");
  });

  it("filterToSinkAccepted() drops reflective_orientation (pending backend acceptance)", () => {
    expect(filteredNames).not.toContain("reflective_orientation");
  });

  it("filterToSinkAccepted() drops processing_mode_systematic (pending backend acceptance)", () => {
    expect(filteredNames).not.toContain("processing_mode_systematic");
  });

  it("filterToSinkAccepted() drops processing_mode_intuitive (pending backend acceptance)", () => {
    expect(filteredNames).not.toContain("processing_mode_intuitive");
  });

  it("filterToSinkAccepted() drops core_motivator_mastery (pending backend acceptance)", () => {
    expect(filteredNames).not.toContain("core_motivator_mastery");
  });

  it("filterToSinkAccepted() drops core_motivator_novelty (pending backend acceptance)", () => {
    expect(filteredNames).not.toContain("core_motivator_novelty");
  });

  it("no signal through filterToSinkAccepted() has a trait_name outside SINK_ACCEPTED_TRAITS", () => {
    for (const name of filteredNames) {
      expect(SINK_ACCEPTED_TRAITS.has(name)).toBe(true);
    }
  });

  it("filterToSinkAccepted() drops all 7 pending-backend traits regardless of vault richness", () => {
    for (const pendingTrait of PENDING_BACKEND_TRAITS) {
      expect(filteredNames).not.toContain(pendingTrait);
    }
  });
});
