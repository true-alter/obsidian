/**
 * vault-trait-engine/obsidian-adapter.ts
 *
 * The ONLY Obsidian-coupled file in the engine.
 * Converts Obsidian's native TFile[] + MetadataCache into the engine's
 * host-agnostic Note[] so the engine itself stays unit-testable offline.
 *
 * Depends on: the `obsidian` module (devDependency, types only at build time).
 * At plugin runtime, Obsidian provides `app.vault` and `app.metadataCache`.
 */

import type { App, TFile } from "obsidian";
import type { Note } from "./types.js";

/**
 * Convert an Obsidian App + TFile[] into the engine's Note[].
 *
 * Reads:
 *   - TFile.stat.mtime / TFile.stat.ctime (modification/creation timestamps)
 *   - app.vault.cachedRead(file) → content length
 *   - app.metadataCache.getFileCache(file) → frontmatter, links, tags
 *
 * Does NOT read vault content for any semantic purpose — only content.length.
 */
export async function obsidianFilesToNotes(
  app: App,
  files: TFile[],
): Promise<Note[]> {
  const notes: Note[] = [];

  for (const file of files) {
    // Content length — cachedRead is non-destructive and returns the file's
    // text, which we immediately measure and discard (never stored, never sent).
    let contentLength = 0;
    try {
      const content = await app.vault.cachedRead(file);
      contentLength = content.length;
    } catch {
      // Skip files that can't be read (e.g. binary files with .md extension)
      continue;
    }

    const cache = app.metadataCache.getFileCache(file);

    // Frontmatter: coerce all values to strings
    const frontmatter: Record<string, string> = {};
    if (cache?.frontmatter) {
      for (const [k, v] of Object.entries(cache.frontmatter)) {
        if (k !== "position") {
          frontmatter[k] = String(v ?? "");
        }
      }
    }

    // Outbound wikilinks: extract link targets (display text stripped)
    // Links include wikilinks and external http links.
    const outboundLinks: string[] = [];
    if (cache?.links) {
      for (const link of cache.links) {
        // link.link is the vault-relative path (wikilink) or URL
        const target = link.link ?? "";
        if (target) outboundLinks.push(target);
      }
    }

    // Tags: strip leading # from each tag string
    const tags: string[] = [];
    if (cache?.tags) {
      for (const tagCache of cache.tags) {
        const tag = tagCache.tag.startsWith("#")
          ? tagCache.tag.slice(1)
          : tagCache.tag;
        if (tag) tags.push(tag);
      }
    }

    // Folder: dirname of vault-relative path (empty string for root)
    const pathParts = file.path.split("/");
    const folder = pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : "";

    notes.push({
      path: file.path,
      mtimeMs: file.stat.mtime,
      ctimeMs: file.stat.ctime,
      contentLength,
      frontmatter,
      outboundLinks,
      tags,
      folder,
    });
  }

  return notes;
}

/**
 * Filter vault TFile[] to a specific subtag folder prefix.
 * The subtag → folder mapping mirrors SUBTAG_TO_FOLDER from inference-emitter.ts.
 * Returns all .md files whose path starts with the given folder prefix.
 */
export const SUBTAG_TO_FOLDER: Record<string, string> = {
  journal: "Journal",
  "manual-note": "Notes",
  "meeting-minutes": "Meetings",
  "reading-note": "Reading",
  daily: "Daily",
};

export function filterFilesBySubtag(files: TFile[], subtag: string): TFile[] {
  const folder = SUBTAG_TO_FOLDER[subtag];
  if (!folder) return [];
  return files.filter(
    (f) =>
      f.path.startsWith(`${folder}/`) && f.path.endsWith(".md"),
  );
}

/**
 * Top-level adapter entry point.
 * Given an Obsidian App, a subtag, and the full vault file list,
 * returns the engine's Note[] for that subtag.
 */
export async function getNotesForSubtag(
  app: App,
  subtag: string,
): Promise<Note[]> {
  const allFiles = app.vault.getMarkdownFiles();
  const filtered = filterFilesBySubtag(allFiles, subtag);
  return obsidianFilesToNotes(app, filtered);
}
