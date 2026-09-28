import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";

import { readImageFiles } from "../src/attachments.ts";
import type { AdvisorConfig } from "../src/config/types.ts";
import { ADVISOR_IMAGE_MAX_BYTES, imageFromPart } from "../src/images.ts";
import { consultAdvisor } from "../src/tools/consultation.ts";
import { withAgentDir } from "./helpers/config-fixture.ts";
import { asExtensionContext } from "./helpers/extension-context.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9S9Y4AAAAASUVORK5CYII=";
const image = { data: png, mimeType: "image/png", type: "image" as const };

const userEntry = {
  id: "user-image",
  message: {
    content: [{ text: "Review this screenshot", type: "text" }, image],
    role: "user",
  },
  type: "message",
};

const contextFor = (cwd: string, faux: any, entries: object[]) =>
  asExtensionContext({
    cwd,
    isProjectTrusted: () => false,
    modelRegistry: {
      find: () => faux.models[0],
      getApiKeyAndHeaders: () => Promise.resolve({ apiKey: "key", ok: true }),
    },
    sessionManager: {
      buildContextEntries: () => entries,
      getBranch: () => entries,
    },
  });

const capturedConsultation = async (
  input: ("text" | "image")[],
  entries: object[],
  config: AdvisorConfig = {}
) => {
  const faux = registerFauxProvider({
    api: "pi-advisor-image-test",
    models: [{ id: "advisor", input }],
    provider: "pi-advisor-image-test",
  });
  let request: any;
  try {
    await withAgentDir(
      {
        advisor: "pi-advisor-image-test/advisor",
        advisorGitContext: "off",
        ...config,
      },
      async (agentDir) => {
        faux.setResponses([
          (context) => {
            request = context.messages.find(
              (message) => message.role === "user"
            );
            return fauxAssistantMessage("Advice");
          },
        ]);
        await consultAdvisor(contextFor(agentDir, faux, entries));
      }
    );
  } finally {
    faux.unregister();
  }
  return request;
};

const pixels = (request: any) =>
  request.content.filter((part: any) => part.type === "image");
const text = (request: any) =>
  request.content
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("\n");

describe("Advisor image disclosure", () => {
  test("forwards real image pixels from selected user and full-policy tool results", async () => {
    const entries = [
      userEntry,
      {
        id: "tool-image",
        message: {
          content: [image],
          role: "toolResult",
          toolName: "read",
        },
        type: "message",
      },
    ];
    const request = await capturedConsultation(["text", "image"], entries);
    expect(pixels(request)).toEqual([image]);
    expect(text(request)).toContain("1 image(s) attached");
    const toolOnly = await capturedConsultation(
      ["text", "image"],
      [entries[1]]
    );
    expect(pixels(toolOnly)).toEqual([image]);
    expect(text(request)).toContain("Review this screenshot");
    expect(text(request)).not.toContain(png);
  });

  test("omits image bytes for text-only models with a truthful note", async () => {
    const request = await capturedConsultation(["text"], [userEntry]);
    expect(pixels(request)).toEqual([]);
    expect(text(request)).toContain("does not support image input");
    expect(text(request)).toContain("no pixels were forwarded");
  });

  test("respects tool policy, text budget, format and size", async () => {
    const toolEntry = {
      message: { content: [image], role: "toolResult", toolName: "read" },
      type: "message",
    };
    const policy = await capturedConsultation(["text", "image"], [toolEntry], {
      advisorToolPolicies: { read: "summary" },
    });
    expect(pixels(policy)).toEqual([]);
    expect(text(policy)).toContain("output omitted by Advisor tool policy");
    const budget = await capturedConsultation(["text", "image"], [userEntry], {
      contextMaxChars: 0,
    });
    expect(pixels(budget)).toEqual([]);
    expect(imageFromPart({ ...image, mimeType: "image/jpeg" })).toBeUndefined();
    expect(imageFromPart({ ...image, data: "not-base64" })).toBeUndefined();
    expect(
      imageFromPart({ ...image, data: "A".repeat(ADVISOR_IMAGE_MAX_BYTES * 2) })
    ).toBeUndefined();
    const bad = await capturedConsultation(
      ["text", "image"],
      [
        {
          message: {
            content: [{ ...image, mimeType: "image/jpeg" }],
            role: "user",
          },
          type: "message",
        },
      ]
    );
    expect(pixels(bad)).toEqual([]);
    expect(text(bad)).toContain("pixels not reviewed");
  });

  test("does not forward older images omitted by the conversation budget", async () => {
    const request = await capturedConsultation(
      ["text", "image"],
      [
        userEntry,
        {
          message: { content: "x".repeat(130), role: "user" },
          type: "message",
        },
      ],
      { contextMaxChars: 300 }
    );
    expect(pixels(request)).toEqual([]);
    expect(text(request)).toContain("Older context omitted");
  });

  test("Scout selection cannot forward pixels from an unselected group", async () => {
    const faux = registerFauxProvider({
      api: "pi-advisor-image-scout-test",
      models: [{ id: "advisor", input: ["text", "image"] }],
      provider: "pi-advisor-image-scout-test",
    });
    let request: any;
    try {
      await withAgentDir(
        {
          advisor: "pi-advisor-image-scout-test/advisor",
          advisorGitContext: "off",
          advisorScoutEnabled: true,
          executor: "pi-advisor-image-scout-test/advisor",
        },
        async (agentDir) => {
          faux.setResponses([
            (context) => {
              const scoutUser = context.messages.find(
                (message) => message.role === "user"
              );
              if (
                scoutUser?.role !== "user" ||
                !Array.isArray(scoutUser.content) ||
                scoutUser.content[0]?.type !== "text"
              ) {
                throw new Error("Missing Scout manifest");
              }
              const manifest = JSON.parse(scoutUser.content[0].text);
              expect(JSON.stringify(manifest)).not.toContain(png);
              expect(
                manifest.groups.some((group: any) =>
                  group.content.includes("[Image ref=")
                )
              ).toBe(true);
              return fauxAssistantMessage(
                JSON.stringify({ selectedIds: [], synthesis: "" })
              );
            },
            (context) => {
              request = context.messages.find(
                (message) => message.role === "user"
              );
              return fauxAssistantMessage("Advice");
            },
          ]);
          await consultAdvisor(
            contextFor(agentDir, faux, [
              userEntry,
              {
                id: "latest",
                message: { content: "Review the code instead", role: "user" },
                type: "message",
              },
            ])
          );
        }
      );
      expect(faux.state.callCount).toBe(2);
      expect(pixels(request)).toEqual([]);
      expect(text(request)).toContain("Review the code instead");
      expect(text(request)).not.toContain("[Image ref=");
    } finally {
      faux.unregister();
    }
  });

  test("explicit untracked images reach the request only with global consent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-advisor-image-request-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    writeFileSync(join(cwd, "capture.png"), Buffer.from(png, "base64"));
    const faux = registerFauxProvider({
      api: "pi-advisor-image-file-test",
      models: [{ id: "advisor", input: ["text", "image"] }],
      provider: "pi-advisor-image-file-test",
    });
    const requests: any[] = [];
    try {
      await withAgentDir(
        {
          advisor: "pi-advisor-image-file-test/advisor",
          advisorGitContext: "off",
          advisorUntrackedContent: true,
        },
        async () => {
          faux.setResponses([
            (context) => {
              requests.push(
                context.messages.find((message) => message.role === "user")
              );
              return fauxAssistantMessage("Advice");
            },
          ]);
          await consultAdvisor(
            contextFor(cwd, faux, []),
            undefined,
            undefined,
            undefined,
            "executor-requested",
            undefined,
            undefined,
            ["capture.png"]
          );
        }
      );
      expect(pixels(requests[0])).toEqual([image]);
      expect(text(requests[0])).toContain(
        'File "capture.png": attached image pixels'
      );
    } finally {
      faux.unregister();
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  test("explicit image files require consent, Git membership and a real supported format", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-advisor-images-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    writeFileSync(join(cwd, "tracked.png"), Buffer.from(png, "base64"));
    execFileSync("git", ["add", "tracked.png"], { cwd, stdio: "ignore" });
    writeFileSync(join(cwd, "new.png"), Buffer.from(png, "base64"));
    writeFileSync(join(cwd, "bad.png"), "not an image");
    symlinkSync(join(cwd, "new.png"), join(cwd, "link.png"));
    try {
      const refused = await readImageFiles(
        cwd,
        ["new.png"],
        false,
        "untracked",
        1000,
        4
      );
      expect(refused).toMatchObject({ images: [], omitted: 1 });
      const accepted = await readImageFiles(
        cwd,
        ["tracked.png", "new.png", "bad.png", "link.png", "../new.png"],
        true,
        "tracked",
        1000,
        4
      );
      expect(accepted.images.map((item) => item.path)).toEqual(["tracked.png"]);
      expect(accepted.omitted).toBe(4);
      const untracked = await readImageFiles(
        cwd,
        ["new.png", "tracked.png"],
        true,
        "untracked",
        1000,
        4
      );
      expect(untracked.images.map((item) => item.path)).toEqual(["new.png"]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});
