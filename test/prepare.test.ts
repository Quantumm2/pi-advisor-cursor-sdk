import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const prepareScript = resolve(import.meta.dirname, "../scripts/prepare.mjs");

const runPrepare = (cwd: string) =>
  spawnSync(process.execPath, [prepareScript], {
    cwd,
    encoding: "utf-8",
  });

const withInstallDir = (run: (cwd: string) => void) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-advisor-prepare-"));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
};

const installFakeHusky = (cwd: string, binSource: string) => {
  const directory = join(cwd, "node_modules/husky");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), "{}\n");
  writeFileSync(join(directory, "bin.js"), binSource);
};

describe("git install prepare script", () => {
  test("succeeds when development dependencies are omitted", () => {
    withInstallDir((cwd) => {
      const result = runPrepare(cwd);
      expect(result.status).toBe(0);
    });
  });

  test("runs husky when it is installed", () => {
    withInstallDir((cwd) => {
      installFakeHusky(cwd, "process.stdout.write('husky-ran\\n');\n");
      const result = runPrepare(cwd);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("husky-ran\n");
    });
  });

  test("preserves a husky installation failure", () => {
    withInstallDir((cwd) => {
      installFakeHusky(cwd, "process.exit(2);\n");
      const result = runPrepare(cwd);
      expect(result.status).toBe(2);
    });
  });
});
