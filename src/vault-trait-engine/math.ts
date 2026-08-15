/**
 * vault-trait-engine/math.ts
 *
 * Pure math helpers: sigmoid, sigmoid-then-softmax, confidence interpolation.
 * Mirrors the backend trait-math mechanics in TypeScript.
 * No I/O, no model, no network. Stdlib only.
 */

// ---------------------------------------------------------------------------
// Sigmoid
// ---------------------------------------------------------------------------

/**
 * Logistic sigmoid: σ(x) = 1 / (1 + e^(-x)).
 *
 * For the vault engine we first map the raw score into [0,1] via min-max
 * normalisation against the calibration band, then apply sigmoid with a
 * discrimination scale factor of 6.0 (matches the backend scale so
 * σ(0) = 0.5 and σ(1) ≈ 0.731, giving meaningful spread over the input range).
 */
export function sigmoid(x: number): number {
  return 1.0 / (1.0 + Math.exp(-x));
}

/**
 * Map a raw score to [0,1] via min-max normalisation then sigmoid with
 * discrimination scale 6.0.
 *
 * calibrationBand: [min, max] — values at or below min → ~0; at or above
 * max → ~1. Clamped before normalisation to avoid extreme sigmoid inputs.
 */
export function sigmoidNorm(
  raw: number,
  calibrationBand: [number, number],
): number {
  const [bMin, bMax] = calibrationBand;
  if (bMax <= bMin) return 0.5; // degenerate band — return neutral
  const clamped = Math.max(bMin, Math.min(bMax, raw));
  // Normalise to [0,1]
  const norm = (clamped - bMin) / (bMax - bMin);
  // Scale by 6 before sigmoid (mirrors the backend) then re-centre so
  // norm=0 → sigmoid(-3) ≈ 0.047 and norm=1 → sigmoid(3) ≈ 0.953.
  // We use a 0-centred scale: sigmoid(6*(norm - 0.5)) maps 0→~0.047, 1→~0.953.
  return sigmoid(6.0 * (norm - 0.5));
}

// ---------------------------------------------------------------------------
// Sigmoid-then-softmax (backend trait-math mechanic)
// ---------------------------------------------------------------------------

/**
 * Apply sigmoid-then-softmax over an array of raw [0,1] scores.
 * Mirrors the backend `motivator_softmax()`:
 *   1. σ(6 * raw) for each element (backend scale, range [0.5, ~0.731]).
 *   2. Numerically stable softmax (subtract max before exp).
 *
 * Returns an array of the same length summing to ~1.0.
 */
export function sigmoidSoftmax(rawScores: number[]): number[] {
  if (rawScores.length === 0) return [];
  // Step 1: sigmoid of each raw score (already in [0,1])
  const sigScores = rawScores.map((v) => sigmoid(6.0 * v));
  // Step 2: numerically stable softmax
  const maxS = Math.max(...sigScores);
  const expScores = sigScores.map((v) => Math.exp(v - maxS));
  const total = expScores.reduce((a, b) => a + b, 0);
  return expScores.map((v) => v / total);
}

// ---------------------------------------------------------------------------
// Confidence interpolation (§4)
// ---------------------------------------------------------------------------

/** Hard confidence constants (Tier-2 self-cap). */
export const CONFIDENCE_FLOOR = 0.15; // emit floor when gate just met
export const CONFIDENCE_CAP = 0.30; // Tier-2 max; sink re-clamps as defence-in-depth

/**
 * Interpolate confidence between CONFIDENCE_FLOOR and CONFIDENCE_CAP
 * based on how far `density` has progressed through the strong-density band
 * [densityGateMin, densityStrongMax].
 *
 * - density <= densityGateMin → CONFIDENCE_FLOOR
 * - density >= densityStrongMax → CONFIDENCE_CAP
 * - in between → linear interpolation
 */
export function interpolateConfidence(
  density: number,
  densityGateMin: number,
  densityStrongMax: number,
): number {
  if (density <= densityGateMin) return CONFIDENCE_FLOOR;
  if (density >= densityStrongMax) return CONFIDENCE_CAP;
  const t = (density - densityGateMin) / (densityStrongMax - densityGateMin);
  return CONFIDENCE_FLOOR + t * (CONFIDENCE_CAP - CONFIDENCE_FLOOR);
}

/**
 * Wire value mapping.
 *
 * DECISION POINT (2026-06-05):
 * Default to [0,1] unipolar — emit sigmoid/softmax outputs directly as the
 * wire value. The backend sink accepts [-1,1] and [0,1] is a valid subset.
 * A parallel falsification agent is verifying whether softmax pairs benefit
 * from bipolar [-1,1] remap; until that verdict lands, we emit [0,1].
 * Change is isolated here — update this function only when the verdict lands.
 */
export function toWireValue(v: number): number {
  // [0,1] unipolar — identity pass-through.
  return Math.max(0, Math.min(1, v));
}
