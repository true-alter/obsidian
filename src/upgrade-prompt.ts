/*
 * upgrade-prompt - Obsidian-channel below-floor upgrade prompt.
 *
 * Minimum-version floor gate. The Obsidian Community plugin has exactly
 * one install channel; users upgrade via the Community Plugins UI inside
 * Obsidian itself. The prompt mirrors the alter-cli `buildUpgradePrompt`
 * shape so the rendering surface is uniform across clients.
 */

import type { ClientBelowFloorEnvelope } from "./floor-preflight";

export const OBSIDIAN_UPGRADE_CMD =
  "update via Obsidian -> Settings -> Community plugins -> Check for updates";

export interface ObsidianUpgradePromptInput {
  currentVersion: string;
  minVersion: string;
}

export interface ObsidianUpgradePromptOutput {
  /** Modal heading. */
  heading: string;
  /** Multi-paragraph body string (newline-joined). */
  body: string;
  /** Channel-specific upgrade command line. */
  upgradeCmd: string;
}

/**
 * Build the channel-correct Obsidian upgrade prompt. Pure function.
 */
export function buildObsidianUpgradePrompt(
  input: ObsidianUpgradePromptInput,
): ObsidianUpgradePromptOutput {
  const heading = "~Alter plugin needs upgrade";
  const body = [
    `Your ~Alter Obsidian plugin (${input.currentVersion}) is below the minimum required version ${input.minVersion}.`,
    "Plugin features are paused until you upgrade.",
    "",
    "To upgrade:",
    "  Settings -> Community plugins -> Check for updates",
    "",
    "After Obsidian fetches the new version, reload the plugin (Settings -> Community plugins -> toggle ~Alter off then on, or restart Obsidian).",
  ].join("\n");
  return { heading, body, upgradeCmd: OBSIDIAN_UPGRADE_CMD };
}

/**
 * Render the canonical below-floor envelope (server reject body shape)
 * as a one-line summary suitable for an Obsidian `Notice` toast - used
 * when the plugin loads below floor and the modal must be deferred (e.g.
 * during automated test runs or when `Modal` is unavailable).
 */
export function summariseEnvelopeForNotice(
  envelope: ClientBelowFloorEnvelope,
): string {
  return `~Alter plugin ${envelope.error.client_version} is below minimum ${envelope.error.min_version}. ${OBSIDIAN_UPGRADE_CMD}.`;
}
