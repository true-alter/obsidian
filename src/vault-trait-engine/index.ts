/**
 * vault-trait-engine/index.ts — public re-exports
 */
export { deriveInferencesForSubtag, filterToSinkAccepted, EMITTED_TRAIT_NAMES, HARD_EXCLUDED_TRAITS, SINK_ACCEPTED_TRAITS } from "./engine.js";
export type { EmittedTraitName } from "./engine.js";
export type { Note, TraitSignal, MethodAudit, VaultSubtag } from "./types.js";
export { getNotesForSubtag, SUBTAG_TO_FOLDER } from "./obsidian-adapter.js";
