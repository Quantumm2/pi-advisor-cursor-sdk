import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { initTheme } from "@earendil-works/pi-coding-agent";

import {
  advisorFallbackModelRef,
  getAdvisorSettings,
  setAdvisorFallbackModelRef,
} from "../src/config/state.ts";
import { loadConfig, saveConfig } from "../src/config/storage.ts";
import { validateConfig } from "../src/config/validation.ts";
import { AdvisorSettingsSelector } from "../src/ui.ts";
import { withAgentDir } from "./helpers/config-fixture.ts";
import { asExtensionContext } from "./helpers/extension-context.ts";
import { focusSettingsRow } from "./helpers/settings-navigation.ts";

initTheme();

// SAFETY: this theme stub implements the only methods the settings selector renders.
const theme = {
  bold: (value: string) => value,
  fg: (_color: string, value: string) => value,
} as any;

describe("Fallback Advisor model configuration", () => {
  test("defaults empty, validates independently, and persists", async () => {
    await withAgentDir({}, async (agentDir) => {
      const ctx = asExtensionContext({
        cwd: agentDir,
        hasUI: false,
        isProjectTrusted: () => false,
      });
      loadConfig(ctx);
      expect(advisorFallbackModelRef).toBeUndefined();
      expect(getAdvisorSettings().fallbackModel).toBeUndefined();
      expect(() => validateConfig({ advisorFallbackModel: 42 })).toThrow(
        "advisorFallbackModel"
      );

      setAdvisorFallbackModelRef("provider/fallback");
      saveConfig(ctx);
      expect(
        JSON.parse(readFileSync(join(agentDir, "advisor.json"), "utf-8"))
          .advisorFallbackModel
      ).toBe("provider/fallback");

      setAdvisorFallbackModelRef(undefined);
      saveConfig(ctx);
      expect(
        JSON.parse(readFileSync(join(agentDir, "advisor.json"), "utf-8"))
      ).not.toHaveProperty("advisorFallbackModel");
    });
  });

  test("selects a fallback model from Advisor settings", () => {
    let saved: any;
    const selector = new AdvisorSettingsSelector({
      effortLevels: ["Default (Model Default)"],
      initial: {
        collapseResponses: false,
        completionGate: true,
        contextMaxChars: 0,
        failureGate: true,
        planGate: true,
      },
      // SAFETY: the test keybindings deny every configured action.
      keybindings: { matches: () => false } as any,
      modelRefs: ["provider/fallback"],
      onCancel: () => {},
      onChange: (settings) => {
        saved = settings;
      },
      presets: [{ description: "none", label: "0", value: 0 }],
      theme,
      tui: { requestRender: () => {} },
    });

    focusSettingsRow(selector, "Fallback Advisor model");
    selector.handleInput("\r");
    selector.handleInput("\u001B[B");
    selector.handleInput("\r");

    expect(saved.fallbackModel).toBe("provider/fallback");
    expect(selector.render(100).join("\n")).toContain("Fallback Advisor model");
    selector.dispose();
  });

  test("clears a configured fallback model from Advisor settings", () => {
    let saved: any;
    const selector = new AdvisorSettingsSelector({
      effortLevels: ["Default (Model Default)"],
      initial: {
        collapseResponses: false,
        completionGate: true,
        contextMaxChars: 0,
        failureGate: true,
        fallbackModel: "provider/fallback",
        planGate: true,
      },
      // SAFETY: the test keybindings deny every configured action.
      keybindings: { matches: () => false } as any,
      modelRefs: ["provider/fallback"],
      onCancel: () => {},
      onChange: (settings) => {
        saved = settings;
      },
      presets: [{ description: "none", label: "0", value: 0 }],
      theme,
      tui: { requestRender: () => {} },
    });

    focusSettingsRow(selector, "Fallback Advisor model");
    selector.handleInput("\r");
    selector.handleInput("\u001B[B");
    selector.handleInput("\r");

    expect(saved.fallbackModel).toBeUndefined();
    selector.dispose();
  });
});
