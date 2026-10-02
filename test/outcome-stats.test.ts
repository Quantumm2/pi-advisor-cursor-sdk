import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { registerCommands } from "../src/commands.ts";
import { formatAdvisorStats } from "../src/commands/outcome-stats.ts";
import { outcomeLogPath } from "../src/outcomes.ts";
import { withAgentDir } from "./helpers/config-fixture.ts";
import { mockPi } from "./helpers/mock-pi.ts";
import { plainThemeMock } from "./helpers/theme.ts";

initTheme();

describe("Advisor outcome stats", () => {
  test("renders an explicit empty state for a missing ledger", async () => {
    await withAgentDir({}, async () => {
      const commands = new Map<string, any>();
      const sent: { message: any; options: any }[] = [];
      registerCommands(mockPi({ commands, sent }));

      await commands.get("advisor-stats").handler("", {
        hasUI: false,
        isProjectTrusted: () => false,
        mode: "print",
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].message.customType).toBe("advisor-stats-result");
      expect(sent[0].message.details.stats.total).toBe(0);
      expect(sent[0].options).toEqual({
        deliverAs: "steer",
        triggerTurn: false,
      });
    });
  });

  test("reads retained records and ignores a malformed trailing line", async () => {
    await withAgentDir({}, async () => {
      writeFileSync(
        outcomeLogPath(),
        `${JSON.stringify({
          adoption: "followed",
          adviceHash: "hash",
          timestamp: "2026-01-01T00:00:00.000Z",
          trigger: "manual",
          v: 1,
          validationStatus: "passed",
        })}\npartial`
      );
      const commands = new Map<string, any>();
      const sent: { message: any; options: any }[] = [];
      registerCommands(mockPi({ commands, sent }));
      await commands.get("advisor-stats").handler("", {
        hasUI: false,
        isProjectTrusted: () => false,
        mode: "print",
      });

      expect(sent[0].message.details.stats.total).toBe(1);
      expect(sent[0].message.details.malformedLines).toBe(1);
    });
  });

  test("uses the Advisor custom-message renderer shell", () => {
    const messageRenderers = new Map<string, any>();
    registerCommands(mockPi({ messageRenderers }));
    const output = messageRenderers
      .get("advisor-stats-result")(
        {
          content: [],
          details: {
            malformedLines: 0,
            stats: {
              adoption: { followed: 2, "not-followed": 1, unknown: 0 },
              byTrigger: {
                "executor-requested": 1,
                manual: 1,
                "repeated-tool-call": 0,
                "turn-gate": 1,
              },
              distinctAdvices: 3,
              firstTimestamp: "2026-01-01T00:00:00.000Z",
              lastTimestamp: "2026-01-03T00:00:00.000Z",
              malformedLines: 0,
              total: 3,
              validationByAdoption: {
                followed: {
                  failed: 1,
                  notRun: 0,
                  passRate: 0.5,
                  passed: 1,
                  total: 2,
                  unknown: 0,
                },
                "not-followed": {
                  failed: 0,
                  notRun: 0,
                  passRate: 1,
                  passed: 1,
                  total: 1,
                  unknown: 0,
                },
                unknown: {
                  failed: 0,
                  notRun: 0,
                  passed: 0,
                  total: 0,
                  unknown: 0,
                },
              },
            },
          },
        },
        { expanded: false },
        plainThemeMock
      )
      .render(120)
      .join("\n");

    expect(output).toContain("ADVISOR · OUTCOME STATS");
    expect(output).toContain("Validation passed rate");
    expect(output).toContain("followed: 50.0% passed (1/2)");
    expect(output).toContain("not-followed: 100.0% passed (1/1)");
  });

  test("formats the empty state without requiring a renderer", () => {
    expect(formatAdvisorStats({ malformedLines: 0 })).toContain(
      "No Advisor outcomes recorded yet"
    );
  });
});
