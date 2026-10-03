import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const huskyPackage = "node_modules/husky/package.json";
const huskyBin = "node_modules/husky/bin.js";

if (!existsSync(huskyPackage)) {
  process.exit(0);
}

const result = spawnSync(process.execPath, [huskyBin], { stdio: "inherit" });
process.exit(result.status ?? 1);
