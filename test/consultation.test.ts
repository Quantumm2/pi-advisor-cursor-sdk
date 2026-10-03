import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

import registerExtension, {
  consultAdvisor,
  runAdvisorGate,
} from "../extensions/index.ts";
import {
  setAdvisorEffortRef,
  setAdvisorRedactSecretsRef,
  setAdvisorScoutEnabledRef,
  setAdvisorToolPoliciesRef,
} from "../src/config.ts";
import { setAdvisorScoutTimeoutMsRef } from "../src/config/state.ts";
import { DEFAULT_SCOUT_TIMEOUT_MS } from "../src/config/types.ts";
import { advisorRequestConversation } from "../src/tools.ts";
import { withAgentDir } from "./helpers/config-fixture.ts";
import { asExtensionContext } from "./helpers/extension-context.ts";
import { fauxRegistryStream } from "./helpers/faux-registry-stream.ts";
import { mockPi } from "./helpers/mock-pi.ts";
import { recordingStream } from "./helpers/scripted-text-stream.ts";
import type { RecordedStreamCall } from "./helpers/scripted-text-stream.ts";

type PromptSections = BeforeAgentStartEvent["systemPromptOptions"]["sections"];

const fauxContext = (
  cwd: string,
  faux: any,
  entries: object[] = [],
  trusted = false
) =>
  asExtensionContext({
    cwd,
    isProjectTrusted: () => trusted,
    modelRegistry: {
      find: () => faux.models[0],
      getApiKeyAndHeaders: () => Promise.resolve({ apiKey: "key", ok: true }),
      streamSimple: fauxRegistryStream,
    },
    sessionManager: {
      buildContextEntries: () => entries,
      getBranch: () => entries,
    },
  });

const configuredModel = (ref: string, api: string) => ({
  api,
  id: ref.slice(ref.indexOf("/") + 1),
  input: ["text"],
  provider: ref.slice(0, ref.indexOf("/")),
});

const registryFor = (
  model: ReturnType<typeof configuredModel>,
  calls: RecordedStreamCall[]
) => ({
  find: () => model,
  getApiKeyAndHeaders: () =>
    Promise.resolve({
      apiKey: "resolved-key",
      env: { REGION: "test" },
      headers: { "x-test": "yes" },
      ok: true as const,
    }),
  streamSimple: recordingStream("Advice", calls),
});

describe("Advisor consultation request construction", () => {
  test("forwards trusted project and global AGENTS.md context with byte accounting", async () => {
    const captured: string[] = [];
    const faux = registerFauxProvider({
      api: "pi-advisor-agents-context-test",
      models: [{ id: "advisor", input: ["text"] }],
      provider: "pi-advisor-agents-context-test",
    });
    try {
      await withAgentDir(
        {
          advisor: "pi-advisor-agents-context-test/advisor",
          advisorAgentsMdContext: true,
          advisorGitContext: "off",
        },
        async (agentDir) => {
          const project = mkdtempSync(join(tmpdir(), "pi-advisor-project-"));
          writeFileSync(join(project, "AGENTS.md"), "project conventions");
          writeFileSync(join(agentDir, "AGENTS.md"), "global conventions");
          try {
            faux.setResponses([
              (context) => {
                captured.push(JSON.stringify(context.messages));
                return fauxAssistantMessage("Advice");
              },
            ]);
            const result = await consultAdvisor(
              fauxContext(project, faux, [], true)
            );
            expect(captured[0]).toContain("<project_rules");
            expect(captured[0]).toContain("[project AGENTS.md]");
            expect(captured[0]).toContain("[global AGENTS.md]");
            expect(result.agentRulesBytes).toBeGreaterThan(0);
          } finally {
            rmSync(project, { force: true, recursive: true });
          }
        }
      );
    } finally {
      faux.unregister();
    }
  });

  test("omits AGENTS.md context when the setting is disabled", async () => {
    const captured: string[] = [];
    const faux = registerFauxProvider({
      api: "pi-advisor-agents-disabled-test",
      models: [{ id: "advisor", input: ["text"] }],
      provider: "pi-advisor-agents-disabled-test",
    });
    try {
      await withAgentDir(
        {
          advisor: "pi-advisor-agents-disabled-test/advisor",
          advisorAgentsMdContext: false,
          advisorGitContext: "off",
        },
        async (agentDir) => {
          const project = mkdtempSync(join(tmpdir(), "pi-advisor-project-"));
          writeFileSync(join(project, "AGENTS.md"), "project conventions");
          writeFileSync(join(agentDir, "AGENTS.md"), "global conventions");
          try {
            faux.setResponses([
              (context) => {
                captured.push(JSON.stringify(context.messages));
                return fauxAssistantMessage("Advice");
              },
            ]);
            const result = await consultAdvisor(
              fauxContext(project, faux, [], true)
            );
            expect(captured[0]).not.toContain("<project_rules");
            expect(result.agentRulesBytes).toBeUndefined();
          } finally {
            rmSync(project, { force: true, recursive: true });
          }
        }
      );
    } finally {
      faux.unregister();
    }
  });

  test("applies redaction at the Advisor request-context boundary", () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const ctx = asExtensionContext({
      sessionManager: {
        getBranch: () => [
          {
            message: { content: `api_key=${secret}`, role: "user" },
            type: "message",
          },
          {
            message: {
              content: secret,
              role: "toolResult",
              toolName: "custom",
            },
            type: "message",
          },
        ],
      },
    });
    setAdvisorRedactSecretsRef(true);
    setAdvisorToolPoliciesRef({});
    try {
      const context = advisorRequestConversation(ctx);
      expect(context).not.toContain(secret);
      expect(context).toContain("[REDACTED SECRET]");
    } finally {
      setAdvisorRedactSecretsRef(false);
      setAdvisorToolPoliciesRef({});
    }
  });

  test("fails automatic gates closed for terminal provider failures", async () => {
    const faux = registerFauxProvider({
      api: "pi-advisor-gate-test",
      models: [{ id: "advisor", input: ["text"] }],
      provider: "pi-advisor-gate-test",
    });
    try {
      await withAgentDir(
        {
          advisor: "pi-advisor-gate-test/advisor",
          advisorGitContext: "off",
        },
        async (agentDir) => {
          faux.setResponses([
            () =>
              fauxAssistantMessage("Decision: proceed", {
                errorMessage: "provider unavailable",
                stopReason: "error",
              }),
            () =>
              fauxAssistantMessage("Decision: proceed", {
                errorMessage: "provider aborted",
                stopReason: "aborted",
              }),
          ]);
          const context = fauxContext(agentDir, faux);
          const outcomes = await Promise.all([
            runAdvisorGate(context, "Review the repeated action."),
            runAdvisorGate(context, "Review the repeated action."),
          ]);
          expect(outcomes).toMatchObject([
            {
              category: "provider-error",
              message: "provider unavailable",
              ok: false,
            },
            {
              category: "provider-error",
              message: "provider aborted",
              ok: false,
            },
          ]);
        }
      );
    } finally {
      faux.unregister();
    }
  });

  test("redacts targeted questions before the provider request", async () => {
    const captured: string[] = [];
    const faux = registerFauxProvider({
      api: "pi-advisor-redaction-test",
      models: [{ id: "advisor", input: ["text"] }],
      provider: "pi-advisor-redaction-test",
    });
    try {
      await withAgentDir(
        {
          advisor: "pi-advisor-redaction-test/advisor",
          advisorGitContext: "off",
          advisorRedactSecrets: true,
        },
        async (agentDir) => {
          faux.setResponses([
            (context) => {
              captured.push(JSON.stringify(context.messages));
              return fauxAssistantMessage("Advice");
            },
          ]);
          const result = await consultAdvisor(
            fauxContext(agentDir, faux),
            "password=hunter2"
          );
          expect(result.markdown).toBe("Advice");
        }
      );
    } finally {
      faux.unregister();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toContain("hunter2");
    expect(captured[0]).toContain("[REDACTED SECRET]");
  });

  test("completes the Advisor call with legacy context after a real Scout timeout", async () => {
    const faux = registerFauxProvider({
      api: "pi-advisor-scout-timeout-test",
      models: [{ id: "advisor", input: ["text"] }],
      provider: "pi-advisor-scout-timeout-test",
    });
    try {
      await withAgentDir(
        {
          advisor: "pi-advisor-scout-timeout-test/advisor",
          advisorGitContext: "off",
          advisorScoutEnabled: true,
          advisorScoutTimeoutMs: 20,
          executor: "pi-advisor-scout-timeout-test/advisor",
        },
        async (agentDir) => {
          const entries = [
            {
              id: "user-entry",
              message: {
                content: "Original context should remain available.",
                role: "user",
              },
              parentId: null,
              timestamp: "2026-01-01T00:00:00Z",
              type: "message",
            },
          ];
          let advisorRequest = "";
          faux.setResponses([
            (_context, options) =>
              new Promise((resolve, reject) => {
                const signal = options?.signal;
                if (!signal) {
                  reject(new Error("Scout response must be abortable"));
                  return;
                }
                const complete = () =>
                  resolve(
                    fauxAssistantMessage('{"selectedIds":[],"synthesis":""}')
                  );
                if (signal.aborted) {
                  complete();
                } else {
                  signal.addEventListener("abort", complete, { once: true });
                }
              }),
            (context) => {
              advisorRequest = JSON.stringify(context.messages);
              return fauxAssistantMessage(
                "Advisor completed after Scout timeout."
              );
            },
          ]);
          const scoutFallbacks: string[] = [];
          const result = await consultAdvisor(
            fauxContext(agentDir, faux, entries),
            "Continue with the original conversation.",
            undefined,
            undefined,
            "executor-requested",
            undefined,
            undefined,
            undefined,
            undefined,
            (event) => {
              if (event.type === "fallback") {
                scoutFallbacks.push(event.outcome.message);
              }
            }
          );
          expect(result.markdown).toBe(
            "Advisor completed after Scout timeout."
          );
          expect(result.scout).toMatchObject({
            category: "timeout",
            message: "Scout timed out after 20 ms.",
            ok: false,
          });
          expect(scoutFallbacks).toEqual(["Scout timed out after 20 ms."]);
          expect(advisorRequest).toContain(
            "User: Original context should remain available."
          );
          expect(faux.state.callCount).toBe(2);
        }
      );
    } finally {
      faux.unregister();
      setAdvisorScoutEnabledRef(false);
      setAdvisorScoutTimeoutMsRef(DEFAULT_SCOUT_TIMEOUT_MS);
    }
  });

  test("injects only the enabled invocation rules into the active prompt", async () => {
    await withAgentDir(
      {
        advisorCompletionGate: false,
        advisorCustomInvocation: "a deployment changes production data",
        advisorFailureGate: true,
        advisorPlanGate: false,
      },
      () => {
        let beforeAgentStart: any;
        registerExtension(
          mockPi(
            { activeTools: ["ask_advisor"] },
            {
              on(event: string, handler: any) {
                if (event === "before_agent_start") {
                  beforeAgentStart = handler;
                }
              },
              registerTool: () => {},
            }
          )
        );
        const sections: PromptSections = {
          mcp_servers: "<mcp_servers>servers</mcp_servers>",
        };
        const result = beforeAgentStart(
          { systemPromptOptions: { sections } },
          {
            cwd: tmpdir(),
            getSystemPrompt: () => "Base prompt",
            isProjectTrusted: () => false,
          }
        );
        const prompt = sections.advisor_invocation_settings;
        expect(result).toBeUndefined();
        expect(sections.mcp_servers).toBe("<mcp_servers>servers</mcp_servers>");
        expect(prompt).toStartWith("Advisor invocation settings:");
        expect(prompt).toContain(
          "two consecutive materially equivalent failed attempts"
        );
        expect(prompt).toContain("a deployment changes production data");
        expect(prompt).not.toContain("consequential plan");
        expect(prompt).not.toContain("Before declaring success");
      }
    );
  });

  test("removes the invocation rules when ask_advisor is inactive", async () => {
    await withAgentDir({ advisorFailureGate: true }, () => {
      let beforeAgentStart: any;
      registerExtension(
        mockPi(
          { activeTools: [] },
          {
            on(event: string, handler: any) {
              if (event === "before_agent_start") {
                beforeAgentStart = handler;
              }
            },
            registerTool: () => {},
          }
        )
      );
      const sections: PromptSections = {
        advisor_invocation_settings: "stale",
        mcp_servers: "servers",
      };
      beforeAgentStart(
        { systemPromptOptions: { sections } },
        { cwd: tmpdir(), isProjectTrusted: () => false }
      );
      expect(sections).toEqual({ mcp_servers: "servers" });
    });
  });

  test("routes Advisor calls through the registered model provider", async () => {
    const streamSpy = spyOn(piAiCompat, "stream");
    try {
      for (const [ref, api] of [
        ["cursor/glm-5p3", "cursor-sdk"],
        ["anthropic/claude-sonnet", "anthropic-messages"],
        ["openai/gpt", "openai-completions"],
      ] as const) {
        const calls: RecordedStreamCall[] = [];
        const model = configuredModel(ref, api);
        await withAgentDir(
          {
            advisor: ref,
            advisorAgentsMdContext: false,
            advisorEffort: "high",
            advisorGitContext: "off",
          },
          async (agentDir) => {
            const result = await consultAdvisor(
              asExtensionContext({
                cwd: agentDir,
                isProjectTrusted: () => false,
                modelRegistry: registryFor(model, calls),
                sessionManager: { getBranch: () => [] },
              }),
              "Review the decision."
            );
            expect(result.markdown).toBe("Advice");
          }
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]?.model).toBe(model);
        expect(calls[0]?.context.systemPrompt).toEqual(expect.any(String));
        expect(Array.isArray(calls[0]?.context.messages)).toBe(true);
        expect(calls[0]?.options).toEqual({
          apiKey: "resolved-key",
          env: { REGION: "test" },
          headers: { "x-test": "yes" },
          reasoning: "high",
          signal: undefined,
        });
      }

      const omitted: RecordedStreamCall[] = [];
      await withAgentDir(
        {
          advisor: "cursor/glm-5p3",
          advisorAgentsMdContext: false,
          advisorEffort: "off",
          advisorGitContext: "off",
        },
        async (agentDir) => {
          await consultAdvisor(
            asExtensionContext({
              cwd: agentDir,
              isProjectTrusted: () => false,
              modelRegistry: registryFor(
                configuredModel("cursor/glm-5p3", "cursor-sdk"),
                omitted
              ),
              sessionManager: { getBranch: () => [] },
            })
          );
        }
      );
      expect(omitted[0]?.options).toMatchObject({ apiKey: "resolved-key" });
      expect(omitted[0]?.options).not.toHaveProperty("reasoning");
      expect(omitted[0]?.options).not.toHaveProperty("reasoningEffort");

      const unset: RecordedStreamCall[] = [];
      setAdvisorEffortRef(undefined);
      await withAgentDir(
        {
          advisor: "anthropic/claude-sonnet",
          advisorAgentsMdContext: false,
          advisorGitContext: "off",
        },
        async (agentDir) => {
          setAdvisorEffortRef(undefined);
          await consultAdvisor(
            asExtensionContext({
              cwd: agentDir,
              isProjectTrusted: () => false,
              modelRegistry: registryFor(
                configuredModel(
                  "anthropic/claude-sonnet",
                  "anthropic-messages"
                ),
                unset
              ),
              sessionManager: { getBranch: () => [] },
            })
          );
        }
      );
      expect(unset[0]?.options).not.toHaveProperty("reasoning");
      expect(unset[0]?.options).not.toHaveProperty("reasoningEffort");
      expect(streamSpy).not.toHaveBeenCalled();
    } finally {
      streamSpy.mockRestore();
    }
  });
});
