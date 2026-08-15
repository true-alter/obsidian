/*
 * ~Alter - Pair your vault. Plugin settings tab.
 *
 * Surfaces the pairing ceremony, return-cadence selector, per-subtag
 * consent toggles, and revoke buttons. Per-subtag granular consent - each
 * subtag toggle round-trips the daemon (grant on enable, revoke on disable).
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type AlterPlugin from "./main";
import { PURPOSE_LABELS, DEFAULT_PURPOSES } from "./pairing-ceremony";
import { MirrorCadence, VaultSubtag } from "./types";

const ALL_SUBTAGS: VaultSubtag[] = [
  "journal",
  "manual-note",
  "meeting-minutes",
  "reading-note",
  "daily",
];

const SUBTAG_LABELS: Record<VaultSubtag, string> = {
  journal: "Journal",
  "manual-note": "Manual notes",
  "meeting-minutes": "Meeting minutes",
  "reading-note": "Reading notes",
  daily: "Daily notes",
};

export class AlterSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: AlterPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("alter-settings");

    containerEl.createEl("h2", { text: "~Alter - Pair your vault" });

    this.renderPairingSection(containerEl);
    this.renderDaemonSection(containerEl);
    this.renderCadenceSection(containerEl);
    this.renderPurposesSection(containerEl);
    this.renderConsentSection(containerEl);
  }

  private renderPairingSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "alter-settings-section" });
    section.createEl("h3", { text: "Pairing" });

    const status = section.createDiv({ cls: "alter-pairing-status" });
    if (this.plugin.settings.pairedHandle) {
      status.addClass("is-paired");
      status.setText(
        `Paired to ${this.plugin.settings.pairedHandle} since ${this.plugin.settings.pairedAt}`,
      );
    } else {
      status.setText("~unpaired");
    }

    new Setting(section)
      .setName(
        this.plugin.settings.pairedHandle
          ? "Repair vault"
          : "Pair this vault to your ~handle",
      )
      .setDesc(
        "Reads ~/.config/alter/session.json, asks you to confirm, then sends a per-subtag consent grant directly to the ~Alter backend. Vault content never leaves the device.",
      )
      .addButton((btn) =>
        btn
          .setButtonText(
            this.plugin.settings.pairedHandle ? "Repair" : "Pair vault",
          )
          .setCta()
          .onClick(async () => {
            await this.plugin.runPairingCeremony();
            this.display();
          }),
      );

    if (this.plugin.settings.pairedHandle) {
      new Setting(section)
        .setName("Unpair this vault")
        .setDesc(
          "Revokes consent grants directly at the ~Alter backend and clears local pairing state. ~Alter/ folder contents are preserved.",
        )
        .addButton((btn) =>
          btn
            .setButtonText("Unpair")
            .setWarning()
            .onClick(async () => {
              await this.plugin.runUnpairCeremony();
              this.display();
            }),
        );
    }
  }

  private renderDaemonSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "alter-settings-section" });
    section.createEl("h3", { text: "Daemon" });

    new Setting(section)
      .setName("Daemon socket path")
      .setDesc(
        "Override the default unix socket / named pipe. Leave empty for the OS default.",
      )
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.defaultSocketPathHint())
          .setValue(this.plugin.settings.daemonSocketPath)
          .onChange(async (v) => {
            this.plugin.settings.daemonSocketPath = v.trim();
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderCadenceSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "alter-settings-section" });
    section.createEl("h3", { text: "Return cadence" });
    section.createEl("p", {
      text: "How often ~Alter renders return events from your vault into ~Alter/.",
    });

    new Setting(section)
      .setName("Cadence")
      .addDropdown((drop) =>
        drop
          .addOption("weekly", "Weekly")
          .addOption("per-entry", "Per entry")
          .addOption("manual-only", "Manual only")
          .setValue(this.plugin.settings.mirrorCadence)
          .onChange(async (v: string) => {
            this.plugin.settings.mirrorCadence = v as MirrorCadence;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderPurposesSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "alter-settings-section" });
    section.createEl("h3", { text: "Purposes consented" });
    section.createEl("p", {
      text:
        "These are the four purposes the backend ledger records when you " +
        "pair your vault. They are fixed and cannot " +
        "be edited from this surface - pair and unpair to revoke consent.",
    });

    const list = section.createEl("ul", { cls: "alter-purposes-list" });
    for (const purpose of DEFAULT_PURPOSES) {
      const li = list.createEl("li");
      const label = PURPOSE_LABELS[purpose] ?? purpose;
      li.setText(label);
    }
  }

  private renderConsentSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "alter-settings-section" });
    section.createEl("h3", { text: "Consented subtags" });
    section.createEl("p", {
      text:
        "Per-subtag granular consent. Toggling a subtag ON " +
        "grants consent directly at the ~Alter backend; toggling OFF revokes it. " +
        "Each subtag carries its own ledger row. Consent is member-self. Revoke " +
        "from any session you are signed in to; no saved token is required.",
    });

    for (const subtag of ALL_SUBTAGS) {
      const consented = this.plugin.settings.consentedSubtags.includes(subtag);
      new Setting(section)
        .setName(SUBTAG_LABELS[subtag])
        .setDesc(`obsidian-vault/${subtag}`)
        .addToggle((toggle) =>
          toggle.setValue(consented).onChange(async (v) => {
            await this.plugin.toggleSubtagConsent(subtag, v);
            this.display();
          }),
        )
        .addButton((btn) =>
          btn
            .setButtonText("Revoke")
            .setWarning()
            .setDisabled(!consented)
            .onClick(async () => {
              await this.plugin.revokeSubtag(subtag);
              this.display();
            }),
        );
    }
  }
}
