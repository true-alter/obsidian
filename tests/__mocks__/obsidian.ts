/*
 * Minimal `obsidian` module stub for vitest. The real module is provided by
 * the Obsidian runtime; tests only need shapes we touch directly.
 */

export class Plugin {
  app: any;
  manifest: any;
  constructor(app: any, manifest: any) {
    this.app = app;
    this.manifest = manifest;
  }
  addRibbonIcon(_a: string, _b: string, _c: () => any): any {}
  addStatusBarItem(): any {
    return { addClass: () => {}, removeClass: () => {}, setText: () => {} };
  }
  addCommand(_c: any): void {}
  addSettingTab(_t: any): void {}
  async loadData(): Promise<any> {
    return null;
  }
  async saveData(_d: any): Promise<void> {}
  registerEvent(_e: any): void {}
}

export class PluginSettingTab {
  app: any;
  containerEl: any;
  constructor(app: any, _plugin: any) {
    this.app = app;
    this.containerEl = { empty: () => {}, createEl: () => ({}), createDiv: () => ({}) };
  }
  display(): void {}
}

export class Modal {
  app: any;
  contentEl: any;
  constructor(app: any) {
    this.app = app;
    this.contentEl = { createEl: () => ({}), createDiv: () => ({}) };
  }
  open(): void {}
  close(): void {}
  onOpen(): void {}
}

export class Notice {
  constructor(_msg: string) {}
}

export class Setting {
  constructor(_el: any) {}
  setName(_s: string): this {
    return this;
  }
  setDesc(_s: string): this {
    return this;
  }
  addButton(cb: (b: any) => any): this {
    cb({
      setButtonText: () => ({
        setCta: () => ({ onClick: () => ({}) }),
        setWarning: () => ({ onClick: () => ({}) }),
        onClick: () => ({}),
      }),
      setCta: () => ({ onClick: () => ({}) }),
      setWarning: () => ({ onClick: () => ({}) }),
      onClick: () => ({}),
      setDisabled: () => ({ onClick: () => ({}) }),
    });
    return this;
  }
  addText(cb: (t: any) => any): this {
    cb({
      setPlaceholder: () => ({ setValue: () => ({ onChange: () => ({}) }) }),
      setValue: () => ({ onChange: () => ({}) }),
      onChange: () => ({}),
    });
    return this;
  }
  addToggle(cb: (t: any) => any): this {
    cb({ setValue: () => ({ onChange: () => ({}) }), onChange: () => ({}) });
    return this;
  }
  addDropdown(cb: (d: any) => any): this {
    cb({
      addOption: () => ({
        addOption: () => ({
          addOption: () => ({ setValue: () => ({ onChange: () => ({}) }) }),
        }),
      }),
      setValue: () => ({ onChange: () => ({}) }),
    });
    return this;
  }
}

export type App = any;
export type PluginManifest = any;

// `requestUrl` left undefined so the floor-preflight `obsidianRequestUrlClient`
// falls back to its `fetch` path in tests. The production module exports a
// real `requestUrl` function.
export const requestUrl: undefined = undefined;

export const Platform: { isDesktop: boolean } = { isDesktop: true };
