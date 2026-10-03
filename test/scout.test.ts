/* biome-ignore-all lint/performance/noAwaitInLoops: table-driven async failure cases intentionally run serially. */
/* biome-ignore-all lint/suspicious/useAwait: async dependency stubs mirror the production contract. */
import { describe, expect, spyOn, test } from "bun:test";

import * as piAiCompat from "@earendil-works/pi-ai/compat";

import { setExecutorEffortRef, setExecutorRef } from "../src/config.ts";
import {
  advisorScoutTimeoutMsRef,
  executorEffortRef,
  executorRef,
  setAdvisorScoutTimeoutMsRef,
} from "../src/config/state.ts";
import { collectTextStream } from "../src/model-stream.ts";
import type {
  CollectTextStreamOptions,
  RegisteredModelStream,
  ResolvedConfiguredModel,
  resolveConfiguredModel,
} from "../src/model-stream.ts";
import type { ScoutManifest } from "../src/scout-context.ts";
import {
  parseScoutSelection,
  runAdvisorScout,
  SCOUT_SYSTEM,
} from "../src/scout.ts";
import { scoutDetailsFromEvent, ScoutStatusManager } from "../src/tools.ts";
import { asExtensionContext } from "./helpers/extension-context.ts";
import {
  recordingStream,
  scriptedTextStream,
} from "./helpers/scripted-text-stream.ts";
import type { RecordedStreamCall } from "./helpers/scripted-text-stream.ts";

const manifest = (): ScoutManifest => ({
  availableBytes: 100,
  availableCount: 3,
  groups: [
    {
      bytes: 10,
      content: "User: current task",
      id: "g_required",
      kind: "user",
      label: "current task",
      originalIndex: 2,
      required: true,
    },
    {
      bytes: 10,
      content: "Executor: useful failure",
      id: "g_failure",
      kind: "assistant",
      label: "useful failure",
      originalIndex: 0,
      required: false,
    },
    {
      bytes: 10,
      content: "Executor: redundant",
      id: "g_other",
      kind: "assistant",
      label: "redundant",
      originalIndex: 1,
      required: false,
    },
  ],
  omittedBytes: 5,
  omittedCount: 1,
});

// SAFETY: fixture model carries only the id/provider fields the mocked collect path reads.
const resolved = {
  apiKey: "key",
  model: { id: "model", provider: "provider" },
  ref: "provider/model",
} as ResolvedConfiguredModel;
/** Deps fixture matching the collect/resolve signatures runAdvisorScout accepts. */
interface ScoutDepsFixture {
  abortSettleMs?: number;
  collect: typeof collectTextStream;
  resolve: typeof resolveConfiguredModel;
  stream?: RegisteredModelStream;
}

const successDependencies = (
  text: string,
  capture?: (options: CollectTextStreamOptions) => void
): ScoutDepsFixture => ({
  collect: (_resolved, options) => {
    capture?.(options);
    return Promise.resolve({
      text,
      thinking: "thought",
      usage: { cost: { total: 0.01 } },
    });
  },
  resolve: () => Promise.resolve(resolved),
});

describe("Advisor Scout", () => {
  test("parses a valid selection and retains useful failures", () => {
    const selection = parseScoutSelection(
      JSON.stringify({
        selectedIds: ["g_required", "g_failure"],
        synthesis: "Failure explains the remaining decision.",
      }),
      manifest()
    );
    expect(selection.selectedIds).toContain("g_failure");
  });

  test("ignores hallucinated IDs and retains required groups", () => {
    const selection = parseScoutSelection(
      JSON.stringify({
        selectedIds: ["g_unknown", "g_failure"],
        synthesis: "Failure explains the remaining decision.",
      }),
      manifest()
    );
    expect(selection.selectedIds).toEqual(["g_required", "g_failure"]);

    const requiredOnly = parseScoutSelection(
      JSON.stringify({
        selectedIds: ["g_unknown"],
        synthesis: "Inference based on an unknown selection.",
      }),
      manifest()
    );
    expect(requiredOnly.selectedIds).toEqual(["g_required"]);
    expect(requiredOnly.synthesis).toBe("");

    const normalized = parseScoutSelection(
      JSON.stringify({
        selectedIds: ["g_other", "g_required", "g_failure"],
        synthesis: "Selections are normalized to manifest order.",
      }),
      manifest()
    );
    expect(normalized.selectedIds).toEqual([
      "g_required",
      "g_failure",
      "g_other",
    ]);
  });

  test("rejects malformed, duplicate, oversized, and extra-key output", () => {
    const invalid = [
      "not json",
      JSON.stringify({
        selectedIds: ["g_required", "g_required"],
        synthesis: "",
      }),
      JSON.stringify({
        selectedIds: ["g_unknown", "g_unknown"],
        synthesis: "",
      }),
      JSON.stringify({
        selectedIds: ["g_required"],
        synthesis: "x".repeat(4097),
      }),
      JSON.stringify({
        extra: true,
        selectedIds: ["g_required"],
        synthesis: "",
      }),
    ];
    for (const value of invalid) {
      expect(() => parseScoutSelection(value, manifest())).toThrow();
    }
  });

  test("uses the configured Executor model and effort with conversation-only input", async () => {
    const previousChildMarker = process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_CHILD;
    try {
      setExecutorRef("provider/executor");
      setExecutorEffortRef("high");
      let options: any;
      const events: string[] = [];
      const outcome = await runAdvisorScout(
        asExtensionContext({}),
        manifest(),
        undefined,
        (event) => events.push(event.type),
        1000,
        successDependencies(
          JSON.stringify({
            selectedIds: ["g_required", "g_failure"],
            synthesis: "Open decision.",
          }),
          (value) => {
            options = value;
          }
        )
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      expect(outcome.model).toBe("provider/executor");
      expect(outcome.conversation).toContain("useful failure");
      expect(outcome.conversation).toContain("non-authoritative inference");
      expect(outcome.metrics.usage).toEqual({ cost: 0.01 });
      expect(options.reasoning).toBe("high");
      expect(options.systemPrompt).toBe(SCOUT_SYSTEM);
      const input = JSON.stringify(options.messages);
      expect(input).toContain("current task");
      expect(input).not.toContain("repository_changes");
      expect(input).not.toContain("tracked_files");
      expect(events).toEqual(["call", "success"]);
    } finally {
      if (previousChildMarker === undefined) {
        delete process.env.PI_SUBAGENT_CHILD;
      } else {
        process.env.PI_SUBAGENT_CHILD = previousChildMarker;
      }
    }
  });

  test("uses the host-pinned model and effort for marked subagent Scout", async () => {
    const previousChildMarker = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    setExecutorRef("provider/parent-executor");
    setExecutorEffortRef("low");
    let options: any;
    let resolvedModel = "";
    try {
      const outcome = await runAdvisorScout(
        asExtensionContext({
          model: { id: "host-model", provider: "provider" },
          thinkingLevel: "high",
        }),
        manifest(),
        undefined,
        undefined,
        1000,
        {
          ...successDependencies(
            JSON.stringify({ selectedIds: ["g_required"], synthesis: "" }),
            (value) => {
              options = value;
            }
          ),
          resolve: (_ctx, model) => {
            resolvedModel = model ?? "";
            return Promise.resolve(resolved);
          },
        }
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      expect(outcome.model).toBe("provider/host-model");
      expect(resolvedModel).toBe("provider/host-model");
      expect(options.reasoning).toBe("high");
    } finally {
      if (previousChildMarker === undefined) {
        delete process.env.PI_SUBAGENT_CHILD;
      } else {
        process.env.PI_SUBAGENT_CHILD = previousChildMarker;
      }
    }
  });

  test("classifies missing model and auth failures without substitution", async () => {
    setExecutorRef("provider/missing");
    for (const [message, category] of [
      ["Scout model not found: provider/missing", "missing-model"],
      ["No API key for provider/missing", "auth-error"],
    ] as const) {
      const outcome = await runAdvisorScout(
        asExtensionContext({}),
        manifest(),
        undefined,
        undefined,
        100,
        {
          collect: async () => {
            throw new Error("must not run");
          },
          resolve: async () => {
            throw new Error(message);
          },
        }
      );
      expect(outcome).toMatchObject({ category, ok: false });
    }
  });

  test("classifies empty and invalid responses as fallback", async () => {
    for (const [text, category] of [
      ["", "empty-response"],
      ["{}", "invalid-selection"],
    ] as const) {
      const outcome = await runAdvisorScout(
        asExtensionContext({}),
        manifest(),
        undefined,
        undefined,
        100,
        successDependencies(text)
      );
      expect(outcome).toMatchObject({ category, ok: false });
    }
  });

  test("retains required groups within the selection limit", () => {
    const groups = Array.from({ length: 33 }, (_, index) => ({
      ...manifest().groups[1],
      id: `g_optional_${index}`,
      label: `optional ${index}`,
      originalIndex: index,
    }));
    const boundedManifest: ScoutManifest = {
      ...manifest(),
      groups: [manifest().groups[0], ...groups],
    };
    const selection = parseScoutSelection(
      JSON.stringify({
        selectedIds: groups.map((group) => group.id).toReversed(),
        synthesis: "Keep the most relevant evidence.",
      }),
      boundedManifest
    );
    expect(selection.selectedIds).toHaveLength(32);
    expect(selection.selectedIds[0]).toBe("g_required");
    expect(selection.selectedIds).toContain("g_optional_32");
    expect(selection.selectedIds).not.toContain("g_optional_0");
  });

  test("rejects manifests with too many required groups", () => {
    const oversizedManifest: ScoutManifest = {
      ...manifest(),
      groups: Array.from({ length: 33 }, (_, index) => ({
        ...manifest().groups[0],
        id: `g_required_${index}`,
        label: `required ${index}`,
        originalIndex: index,
      })),
    };
    expect(() =>
      parseScoutSelection(
        JSON.stringify({ selectedIds: [], synthesis: "" }),
        oversizedManifest
      )
    ).toThrow("Manifest contains more than 32 required groups");
  });

  test("curates successfully when the model includes an unknown group ID", async () => {
    const outcome = await runAdvisorScout(
      asExtensionContext({}),
      manifest(),
      undefined,
      undefined,
      100,
      successDependencies(
        JSON.stringify({
          selectedIds: ["g_unknown", "g_failure"],
          synthesis: "Useful failure retained.",
        })
      )
    );
    expect(outcome).toMatchObject({
      metrics: { selectedCount: 2 },
      ok: true,
      selectedLabels: ["current task", "useful failure"],
    });
    if (!outcome.ok) {
      return;
    }
    expect(outcome.selection.selectedIds).toEqual(["g_required", "g_failure"]);
  });

  test("uses the configured response-stream timeout and propagates its abort signal", async () => {
    const previousTimeout = advisorScoutTimeoutMsRef;
    setAdvisorScoutTimeoutMsRef(5);
    let childSignal: AbortSignal | undefined;
    try {
      const outcome = await runAdvisorScout(
        asExtensionContext({}),
        manifest(),
        undefined,
        undefined,
        undefined,
        {
          collect: async (
            _resolved: ResolvedConfiguredModel,
            options: CollectTextStreamOptions
          ) => {
            const { signal } = options;
            if (!signal) {
              throw new Error("scout must pass an abort signal");
            }
            childSignal = signal;
            await new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              })
            );
            throw new Error("unreachable");
          },
          resolve: async () => resolved,
        }
      );
      expect(childSignal?.aborted).toBe(true);
      expect(outcome).toMatchObject({
        category: "timeout",
        message: "Scout timed out after 5 ms.",
        ok: false,
      });
    } finally {
      setAdvisorScoutTimeoutMsRef(previousTimeout);
    }
  });

  test("holds the timeout fallback until the aborted Scout stream settles", async () => {
    let releaseCollection: (() => void) | undefined;
    let settled = false;
    const outcomePromise = runAdvisorScout(
      asExtensionContext({}),
      manifest(),
      undefined,
      undefined,
      15,
      {
        abortSettleMs: 2000,
        collect: () =>
          new Promise((resolve) => {
            releaseCollection = () => {
              settled = true;
              resolve({ text: "", thinking: "", usage: {} });
            };
          }),
        resolve: async () => resolved,
      }
    );
    let returned = false;
    const watched = outcomePromise.then((outcome) => {
      returned = true;
      return outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(returned).toBe(false);
    expect(settled).toBe(false);
    releaseCollection?.();
    const outcome = await watched;
    expect(settled).toBe(true);
    expect(outcome).toMatchObject({
      category: "timeout",
      message: "Scout timed out after 15 ms.",
      ok: false,
    });
  });

  test("returns the timeout fallback when the aborted Scout stream never settles", async () => {
    const outcome = await runAdvisorScout(
      asExtensionContext({}),
      manifest(),
      undefined,
      undefined,
      5,
      {
        abortSettleMs: 20,
        collect: () => new Promise(() => {}),
        resolve: async () => resolved,
      }
    );
    expect(outcome).toMatchObject({
      category: "timeout",
      message: "Scout timed out after 5 ms.",
      ok: false,
    });
  });

  test("starts the timeout after model and auth resolution", async () => {
    const previousTimeout = advisorScoutTimeoutMsRef;
    setAdvisorScoutTimeoutMsRef(5);
    try {
      const outcome = await runAdvisorScout(
        asExtensionContext({}),
        manifest(),
        undefined,
        undefined,
        undefined,
        {
          collect: async () => ({
            text: JSON.stringify({
              selectedIds: ["g_required"],
              synthesis: "",
            }),
            thinking: "",
            usage: {},
          }),
          resolve: async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return resolved;
          },
        }
      );
      expect(outcome.ok).toBe(true);
    } finally {
      setAdvisorScoutTimeoutMsRef(previousTimeout);
    }
  });

  test("parent abort cancels and never reports fallback", async () => {
    const parent = new AbortController();
    const events: string[] = [];
    const promise = runAdvisorScout(
      asExtensionContext({}),
      manifest(),
      parent.signal,
      (event) => events.push(event.type),
      1000,
      {
        collect: async (
          _resolved: ResolvedConfiguredModel,
          options: CollectTextStreamOptions
        ) => {
          const { signal } = options;
          if (!signal) {
            throw new Error("scout must pass an abort signal");
          }
          await new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              {
                once: true,
              }
            )
          );
          throw new Error("unreachable");
        },
        resolve: async () => resolved,
      }
    );
    parent.abort();
    const outcome = await promise;
    expect(outcome).toEqual({ cancelled: true, ok: false });
    expect(events).toContain("cancelled");
    expect(events).not.toContain("fallback");
  });

  test("provider failures retain separate Scout metrics", async () => {
    const outcome = await runAdvisorScout(
      asExtensionContext({}),
      manifest(),
      undefined,
      undefined,
      100,
      {
        collect: async () => {
          throw new Error("provider unavailable");
        },
        resolve: async () => resolved,
      }
    );
    expect(outcome).toMatchObject({
      category: "provider-error",
      metrics: { availableCount: 3, omittedBeforeScout: 1, selectedCount: 0 },
      ok: false,
    });
  });

  test("routes Scout through the registered provider for cursor and native models", async () => {
    const previousChild = process.env.PI_SUBAGENT_CHILD;
    const previousExecutor = executorRef;
    const previousEffort = executorEffortRef;
    delete process.env.PI_SUBAGENT_CHILD;
    const streamSpy = spyOn(piAiCompat, "stream");
    const scoutJson = JSON.stringify({
      selectedIds: ["g_required"],
      synthesis: "Kept the current task.",
    });
    try {
      for (const api of ["cursor-sdk", "anthropic-messages"] as const) {
        const calls: RecordedStreamCall[] = [];
        const configured = {
          api,
          id: api,
          input: ["text"],
          provider: "provider",
        };
        setExecutorRef(`provider/${api}`);
        setExecutorEffortRef("high");
        const outcome = await runAdvisorScout(
          asExtensionContext({
            modelRegistry: {
              find: () => configured,
              getApiKeyAndHeaders: () =>
                Promise.resolve({
                  apiKey: "resolved-key",
                  env: { REGION: "test" },
                  headers: { "x-test": "yes" },
                  ok: true as const,
                }),
              streamSimple: recordingStream(scoutJson, calls),
            },
          }),
          manifest(),
          undefined,
          undefined,
          1000
        );
        expect(outcome.ok).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.model).toBe(configured);
        expect(calls[0]?.context.systemPrompt).toBe(SCOUT_SYSTEM);
        expect(calls[0]?.options).toMatchObject({
          apiKey: "resolved-key",
          env: { REGION: "test" },
          headers: { "x-test": "yes" },
          reasoning: "high",
        });
        expect(calls[0]?.options).not.toHaveProperty("reasoningEffort");
      }

      for (const effort of [undefined, "off"] as const) {
        const calls: RecordedStreamCall[] = [];
        setExecutorEffortRef(effort);
        await runAdvisorScout(
          asExtensionContext({
            modelRegistry: {
              find: () => ({
                api: "openai-completions",
                id: "gpt",
                input: ["text"],
                provider: "openai",
              }),
              getApiKeyAndHeaders: () =>
                Promise.resolve({ apiKey: "resolved-key", ok: true as const }),
              streamSimple: recordingStream(scoutJson, calls),
            },
          }),
          manifest(),
          undefined,
          undefined,
          1000
        );
        expect(calls[0]?.options).toMatchObject({ apiKey: "resolved-key" });
        expect(calls[0]?.options).not.toHaveProperty("reasoning");
        expect(calls[0]?.options).not.toHaveProperty("reasoningEffort");
      }

      setExecutorRef("cursor/grok-4.7@256k");
      const thrown = await runAdvisorScout(
        asExtensionContext({
          modelRegistry: {
            find: () => ({
              api: "cursor-sdk",
              id: "grok-4.7@256k",
              input: ["text"],
              provider: "cursor",
            }),
            getApiKeyAndHeaders: () =>
              Promise.resolve({ apiKey: "placeholder", ok: true as const }),
            streamSimple: () => {
              throw new Error("No API provider registered for api: cursor-sdk");
            },
          },
        }),
        manifest(),
        undefined,
        undefined,
        1000
      );
      expect(thrown).toMatchObject({
        category: "provider-error",
        message: "No API provider registered for api: cursor-sdk",
        ok: false,
      });

      const served: RecordedStreamCall[] = [];
      const servedOutcome = await runAdvisorScout(
        asExtensionContext({
          modelRegistry: {
            find: () => ({
              api: "cursor-sdk",
              id: "grok-4.7@256k",
              input: ["text"],
              provider: "cursor",
            }),
            getApiKeyAndHeaders: () =>
              Promise.resolve({ apiKey: "placeholder", ok: true as const }),
            streamSimple: recordingStream(scoutJson, served),
          },
        }),
        manifest(),
        undefined,
        undefined,
        1000
      );
      expect(served).toHaveLength(1);
      expect(servedOutcome.ok).toBe(true);

      let registryCalls = 0;
      const injected = await runAdvisorScout(
        asExtensionContext({
          modelRegistry: {
            streamSimple: () => {
              registryCalls += 1;
              throw new Error("registry must not run");
            },
          },
        }),
        manifest(),
        undefined,
        undefined,
        1000,
        {
          collect: collectTextStream,
          resolve: () => Promise.resolve(resolved),
          // SAFETY: fake stream exposes only the iterator and result() members collectTextStream reads.
          stream: (() => scriptedTextStream(scoutJson)) as any,
        }
      );
      expect(registryCalls).toBe(0);
      expect(injected.ok).toBe(true);
      expect(streamSpy).not.toHaveBeenCalled();
    } finally {
      streamSpy.mockRestore();
      setExecutorRef(previousExecutor);
      setExecutorEffortRef(previousEffort);
      if (previousChild === undefined) {
        delete process.env.PI_SUBAGENT_CHILD;
      } else {
        process.env.PI_SUBAGENT_CHILD = previousChild;
      }
    }
  });
});

/** Lifecycle members the status manager reacts to; outcome bodies are illustrative. */
type ScoutLifecycleEventForStatus = Parameters<ScoutStatusManager["update"]>[2];

const statusContext = (statuses: (string | undefined)[]) =>
  asExtensionContext({
    hasUI: true,
    ui: {
      setStatus: (_key: string, value: string | undefined) =>
        statuses.push(value),
    },
  });

describe("Scout status ownership", () => {
  test("does not turn fallback metrics into a zero-kept selection summary", () => {
    const details = scoutDetailsFromEvent({
      outcome: {
        category: "timeout",
        message: "Scout timed out after 30000 ms.",
        metrics: {
          availableCount: 55,
          inputBytes: 1000,
          latencyMs: 30_000,
          omittedBeforeScout: 2,
          selectedCount: 0,
        },
        model: "provider/executor",
        ok: false,
      },
      type: "fallback",
    });
    expect(details.status).toBe("fallback");
    expect(details).not.toHaveProperty("selectedCount");
  });

  test("keeps a newer active status when an older invocation releases", () => {
    const statuses: (string | undefined)[] = [];
    const manager = new ScoutStatusManager();
    const ctx = statusContext(statuses);
    const older = Symbol("older");
    const newer = Symbol("newer");
    manager.update(ctx, older, { model: "executor", type: "call" });
    manager.update(ctx, newer, { model: "executor", type: "call" });
    manager.release(ctx, older);
    expect(statuses.at(-1)).toBe("Scout curating…");
    manager.release(ctx, newer);
    expect(statuses.at(-1)).toBeUndefined();
  });

  test("shutdown clear prevents late callbacks from reacquiring status", () => {
    const statuses: (string | undefined)[] = [];
    const manager = new ScoutStatusManager();
    const ctx = statusContext(statuses);
    const token = Symbol("old-session");
    manager.update(ctx, token, { model: "executor", type: "call" });
    manager.clear(ctx);
    manager.update(ctx, token, {
      model: "executor",
      text: "",
      thinking: "",
      type: "chunk",
    });
    expect(statuses).toEqual(["Scout curating…", undefined]);
  });

  test("success, fallback, and cancellation release their status", () => {
    for (const event of [
      {
        outcome: {
          conversation: "selected",
          metrics: {
            availableCount: 1,
            inputBytes: 1,
            latencyMs: 1,
            omittedBeforeScout: 0,
            selectedCount: 1,
          },
          model: "executor",
          ok: true,
          selectedLabels: [],
          selection: { selectedIds: [], synthesis: "" },
        },
        type: "success",
      },
      {
        outcome: {
          category: "timeout",
          message: "timeout",
          metrics: {
            availableCount: 1,
            inputBytes: 1,
            latencyMs: 1,
            omittedBeforeScout: 0,
            selectedCount: 0,
          },
          model: "executor",
          ok: false,
        },
        type: "fallback",
      },
      { type: "cancelled" },
    ] as const) {
      const statuses: (string | undefined)[] = [];
      const manager = new ScoutStatusManager();
      const ctx = statusContext(statuses);
      const token = Symbol("invocation");
      manager.update(ctx, token, { model: "executor", type: "call" });
      // SAFETY: fixture events carry the union member shapes update() switches on; outcome bodies are illustrative.
      manager.update(ctx, token, event as ScoutLifecycleEventForStatus);
      expect(statuses.at(-1)).toBeUndefined();
    }
  });
});
