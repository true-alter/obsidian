import { describe, it, expect, beforeEach } from "vitest";
import { AlterFolder, PATHS, slugify, VaultAdapter } from "../src/alter-folder";

class InMemoryAdapter implements VaultAdapter {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || this.dirs.has(p);
  }
  async mkdir(p: string): Promise<void> {
    this.dirs.add(p);
  }
  async read(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async write(p: string, data: string): Promise<void> {
    this.files.set(p, data);
  }
}

describe("AlterFolder", () => {
  let adapter: InMemoryAdapter;
  let folder: AlterFolder;

  beforeEach(() => {
    adapter = new InMemoryAdapter();
    folder = new AlterFolder(adapter);
  });

  it("creates ~Alter/, subfolders, sentinel, RETURN.md, INCOME.md", async () => {
    await folder.ensureFolder();
    expect(adapter.dirs.has(PATHS.ALTER_FOLDER)).toBe(true);
    expect(adapter.dirs.has(PATHS.THEMES_FOLDER)).toBe(true);
    expect(adapter.dirs.has(PATHS.CONSEQUENCES_FOLDER)).toBe(true);
    expect(adapter.files.has(PATHS.SENTINEL_PATH)).toBe(true);
    expect(adapter.files.has(PATHS.RETURN_PATH)).toBe(true);
    expect(adapter.files.has(PATHS.INCOME_PATH)).toBe(true);
  });

  it("ensureFolder is idempotent - does not overwrite sentinel", async () => {
    await folder.ensureFolder();
    const sentinelV1 = adapter.files.get(PATHS.SENTINEL_PATH)!;
    // Mutate to simulate user edit (we treat ensureFolder as best-effort
    // create; idempotence here means "no overwrite when present").
    adapter.files.set(PATHS.SENTINEL_PATH, sentinelV1 + "\nuser edit\n");
    await folder.ensureFolder();
    expect(adapter.files.get(PATHS.SENTINEL_PATH)).toContain("user edit");
  });

  it("sentinel content carries the managed_by + do_not_edit frontmatter", async () => {
    await folder.ensureFolder();
    const body = adapter.files.get(PATHS.SENTINEL_PATH)!;
    expect(body).toContain("managed_by: alter-obsidian-plugin");
    expect(body).toContain("do_not_edit: true");
  });

  it("appendReturn appends a timestamped block", async () => {
    await folder.appendReturn("first reflection", "2026-04-25T10:00:00Z");
    await folder.appendReturn("second reflection", "2026-04-25T11:00:00Z");
    const body = adapter.files.get(PATHS.RETURN_PATH)!;
    expect(body).toContain("## 2026-04-25T10:00:00Z");
    expect(body).toContain("first reflection");
    expect(body).toContain("## 2026-04-25T11:00:00Z");
    expect(body).toContain("second reflection");
  });

  it("writeTheme slugifies the theme name", async () => {
    await folder.writeTheme("Recognition Over Qualification!", "body");
    expect(adapter.files.has(`${PATHS.THEMES_FOLDER}/recognition-over-qualification.md`)).toBe(
      true,
    );
  });

  it("writeConsequence appends to existing date file", async () => {
    await folder.writeConsequence("2026-04-25", "first");
    await folder.writeConsequence("2026-04-25", "second");
    const body = adapter.files.get(`${PATHS.CONSEQUENCES_FOLDER}/2026-04-25.md`)!;
    expect(body).toContain("first");
    expect(body).toContain("second");
  });

  it("writePairing renders the granted subtags and no token (member-self)", async () => {
    await folder.writePairing({
      handle: "~example",
      vault_path_hash: "abc123",
      granted_at: "2026-04-25T12:00:00Z",
      purposes: ["mirror_reflection", "identity_income"],
      subtags: ["journal", "manual-note"],
    });
    const body = adapter.files.get(PATHS.PAIRING_PATH)!;
    // Stream tags are surfaced in canonical hyphenated form.
    expect(body).toContain("obsidian-vault/journal");
    expect(body).toContain("obsidian-vault/manual-note");
    // Member-self consent: no revocation-token machinery is persisted.
    expect(body).not.toMatch(/revocation_token/);
    expect(body).not.toMatch(/token_hash/);
  });

  it("slugify trims, lowercases, hyphenates, caps length", () => {
    expect(slugify("  Hello, World!  ")).toBe("hello-world");
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});
