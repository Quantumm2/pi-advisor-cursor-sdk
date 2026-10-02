import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aggregateOutcomeRecords,
  parseOutcomeLog,
} from "../src/outcome-stats.ts";
import { appendOutcome, outcomeLogPath } from "../src/outcomes.ts";

describe("outcome log", () => {
  test("writes only the versioned allowlisted privacy-minimal record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-advisor-outcomes-"));
    const prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    const advice =
      "raw advice SENTINEL_PROMPT /private/path session-123 tool output";
    try {
      await appendOutcome({
        adoption: "followed",
        advice,
        trigger: "executor-requested",
        validationStatus: "passed",
      });
      const raw = readFileSync(outcomeLogPath(), "utf-8");
      const parsed = JSON.parse(raw);
      expect(Object.keys(parsed).toSorted()).toEqual([
        "adoption",
        "adviceHash",
        "timestamp",
        "trigger",
        "v",
        "validationStatus",
      ]);
      expect(parsed).toMatchObject({
        adoption: "followed",
        trigger: "executor-requested",
        v: 1,
        validationStatus: "passed",
      });
      expect(raw).not.toContain("SENTINEL_PROMPT");
      expect(raw).not.toContain("/private/path");
      expect(raw).not.toContain("session-123");
      chmodSync(outcomeLogPath(), 0o644);
      await appendOutcome({
        adoption: "unknown",
        advice: "second",
        trigger: "manual",
        validationStatus: "not-run",
      });
      expect(statSync(outcomeLogPath()).mode % 0o1000).toBe(0o600);
    } finally {
      if (prior === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = prior;
      }
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("aggregates triggers, adoption, validation rates, and malformed lines", () => {
    const parsed = parseOutcomeLog(
      [
        JSON.stringify({
          adoption: "followed",
          adviceHash: "a",
          timestamp: "2026-01-01T00:00:00.000Z",
          trigger: "manual",
          v: 1,
          validationStatus: "passed",
        }),
        JSON.stringify({
          adoption: "followed",
          adviceHash: "b",
          timestamp: "2026-01-02T00:00:00.000Z",
          trigger: "turn-gate",
          v: 1,
          validationStatus: "failed",
        }),
        JSON.stringify({
          adoption: "followed",
          adviceHash: "d",
          timestamp: "2026-01-02T12:00:00.000Z",
          trigger: "manual",
          v: 1,
          validationStatus: "not-run",
        }),
        JSON.stringify({
          adoption: "not-followed",
          adviceHash: "c",
          timestamp: "2026-01-03T00:00:00.000Z",
          trigger: "executor-requested",
          v: 1,
          validationStatus: "passed",
        }),
        JSON.stringify({
          adoption: "unknown",
          adviceHash: "a",
          timestamp: "2026-01-04T00:00:00.000Z",
          trigger: "repeated-tool-call",
          v: 1,
          validationStatus: "not-run",
        }),
        "{truncated",
      ].join("\n")
    );
    const stats = aggregateOutcomeRecords(
      parsed.records,
      parsed.malformedLines
    );

    expect(parsed.malformedLines).toBe(1);
    expect(stats.total).toBe(5);
    expect(stats.byTrigger).toEqual({
      "executor-requested": 1,
      manual: 2,
      "repeated-tool-call": 1,
      "turn-gate": 1,
    });
    expect(stats.adoption).toEqual({
      followed: 3,
      "not-followed": 1,
      unknown: 1,
    });
    expect(stats.validationByAdoption.followed).toMatchObject({
      failed: 1,
      passRate: 0.5,
      passed: 1,
      total: 3,
    });
    expect(stats.validationByAdoption["not-followed"]).toMatchObject({
      passRate: 1,
      passed: 1,
      total: 1,
    });
    expect(stats.distinctAdvices).toBe(4);
    expect(stats.firstTimestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(stats.lastTimestamp).toBe("2026-01-04T00:00:00.000Z");
  });

  test("keeps concurrent appends and uses one exclusively created salt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-advisor-outcomes-"));
    const prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      writeFileSync(join(dir, "advisor-outcomes-salt"), "");
      const staleLock = `${outcomeLogPath()}.lock`;
      writeFileSync(staleLock, "");
      const stale = new Date(Date.now() - 60_000);
      utimesSync(staleLock, stale, stale);
      await Promise.all(
        Array.from({ length: 20 }, () =>
          appendOutcome({
            adoption: "unknown",
            advice: "same advice",
            trigger: "manual",
            validationStatus: "not-run",
          })
        )
      );
      const records = readFileSync(outcomeLogPath(), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records).toHaveLength(20);
      expect(new Set(records.map((record) => record.adviceHash)).size).toBe(1);
    } finally {
      if (prior === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = prior;
      }
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
