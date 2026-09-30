import { describe, expect, test } from "bun:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { uiAction, uiAvailable } from "../src/ui-guard.ts";

const staleContextError = () =>
  new Error(
    "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx."
  );

const staleCtx = (): ExtensionContext =>
  // SAFETY: only ctx.hasUI is exercised; the getter throws pi's stale error.
  ({
    get hasUI(): boolean {
      throw staleContextError();
    },
    mode: "print",
  }) as any;

const activeCtx = (ui: {
  setStatus: (key: string) => void;
}): ExtensionContext =>
  // SAFETY: only ctx.hasUI and ctx.ui.setStatus are exercised.
  ({ hasUI: true, ui }) as any;

describe("ui-guard", () => {
  test("uiAvailable returns false for stale ctx", () => {
    expect(uiAvailable(staleCtx())).toBe(false);
  });

  test("uiAvailable rethrows non-stale errors", () => {
    // SAFETY: only the hasUI getter is exercised; it throws a non-stale error.
    const ctx = {
      get hasUI(): boolean {
        throw new Error("unrelated failure");
      },
    } as any;
    expect(() => uiAvailable(ctx)).toThrow("unrelated failure");
  });

  test("uiAction no-ops for stale ctx", () => {
    let ran = false;
    expect(() =>
      uiAction(staleCtx(), () => {
        ran = true;
      })
    ).not.toThrow();
    expect(ran).toBe(false);
  });

  test("uiAction runs the action on an active ctx", () => {
    const calls: string[] = [];
    uiAction(activeCtx({ setStatus: (key) => calls.push(key) }), (ui) =>
      ui.setStatus("x", undefined)
    );
    expect(calls).toEqual(["x"]);
  });

  test("uiAction rethrows non-stale action failures", () => {
    expect(() =>
      uiAction(activeCtx({ setStatus: () => {} }), () => {
        throw new Error("setStatus exploded");
      })
    ).toThrow("setStatus exploded");
  });
});
