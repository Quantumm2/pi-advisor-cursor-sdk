import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai/compat";

import { isString } from "./content-utils.ts";
import { ADVISOR_IMAGE_MAX_BYTES, imageFromBytes } from "./images.ts";
import { redactAndCapText } from "./redaction.ts";

export const ADVISOR_FILE_MAX_BYTES = 8 * 1024;
const ADVISOR_FILES_TOTAL_MAX_BYTES = 24 * 1024;
export interface UntrackedAttachment {
  bytes: number;
  path: string;
  text: string;
}

export interface ImageAttachment {
  bytes: number;
  image: ImageContent;
  path: string;
}

const imageExtensions = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);
const imageMime = (path: string) =>
  imageExtensions.get(path.slice(path.lastIndexOf(".")).toLowerCase());
const imageFileCandidate = (path: string) =>
  Boolean(imageMime(path)) || /\.(?:avif|bmp|heic|svg|tiff?)$/iu.test(path);

const PATH_SEGMENTS = /[\\/]/u;

const within = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("..") && !path.includes("../");
};
const normalizeRelativePath = (root: string, path: string) =>
  relative(root, resolve(root, path));

const normalizeRequestedPath = (root: string, value: string) => {
  if (
    !isString(value) ||
    !value ||
    isAbsolute(value) ||
    value.split(PATH_SEGMENTS).includes("..")
  ) {
    return;
  }
  return normalizeRelativePath(root, value);
};

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
    windowsHide: true,
  });

const repositoryRoot = (cwd: string) => {
  try {
    return realpath(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  } catch {
    return Promise.resolve();
  }
};

const untracked = (cwd: string, path: string) => {
  const output = git(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    path,
  ]);
  const expected = normalizeRelativePath(cwd, path);
  return output
    .split("\0")
    .filter(Boolean)
    .some((entry) => normalizeRelativePath(cwd, entry) === expected);
};

const tracked = (cwd: string, path: string) => {
  const output = git(cwd, ["ls-files", "--stage", "-z", "--", path]);
  const expected = normalizeRelativePath(cwd, path);
  return output.split("\0").some((entry) => {
    if (!entry) {
      return false;
    }
    const [metadata, name] = entry.split("\t");
    return (
      name &&
      normalizeRelativePath(cwd, name) === expected &&
      !metadata.startsWith("160000 ")
    );
  });
};

const isPermitted = (
  root: string,
  path: string,
  kind: "tracked" | "untracked"
) => (kind === "tracked" ? tracked(root, path) : untracked(root, path));

const readAttachment = async (
  root: string,
  normalizedName: string,
  redact: boolean,
  available: number
): Promise<UntrackedAttachment | undefined> => {
  const absolute = resolve(root, normalizedName);
  if (!(within(root, absolute) && available > 0)) {
    return;
  }
  const stats = await lstat(absolute);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return;
  }
  const resolved = await realpath(absolute);
  if (!within(root, resolved)) {
    return;
  }
  // fs.open needs combined numeric flags for O_NOFOLLOW; O_RDONLY (0) and O_NOFOLLOW occupy disjoint bits, so + is exact.
  const flags = constants.O_NOFOLLOW
    ? constants.O_RDONLY + constants.O_NOFOLLOW
    : constants.O_RDONLY;
  const file = await open(resolved, flags);
  try {
    const openedStats = await file.stat();
    if (!openedStats.isFile()) {
      return;
    }
    const buffer = Buffer.alloc(available + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const raw = buffer.subarray(0, bytesRead).toString("utf-8");
    if (raw.includes("\0")) {
      return;
    }
    const text = redactAndCapText(raw, available, redact);
    return {
      bytes: Buffer.byteLength(text, "utf-8"),
      path: normalizedName,
      text,
    };
  } finally {
    await file.close();
  }
};

/** Reads exact, permitted regular-file bodies. Refusals are silent. */
const readFiles = async (
  cwd: string,
  requested: string[],
  enabled: boolean,
  redact: boolean,
  kind: "tracked" | "untracked",
  totalLimit = ADVISOR_FILES_TOTAL_MAX_BYTES
): Promise<UntrackedAttachment[]> => {
  if (!(enabled && Array.isArray(requested))) {
    return [];
  }
  const root = await repositoryRoot(cwd);
  if (!root) {
    return [];
  }
  const unique = new Set<string>();
  const attachments: UntrackedAttachment[] = [];
  let total = 0;
  for (const name of requested) {
    const normalizedName = normalizeRequestedPath(root, name);
    if (
      !normalizedName ||
      unique.has(normalizedName) ||
      imageFileCandidate(normalizedName)
    ) {
      continue;
    }
    unique.add(normalizedName);
    try {
      if (!isPermitted(root, normalizedName, kind)) {
        continue;
      }
      const available = Math.min(ADVISOR_FILE_MAX_BYTES, totalLimit - total);
      if (available <= 0) {
        break;
      }
      // Sequentially enforce the aggregate disclosure budget.
      const attachment = await readAttachment(
        root,
        normalizedName,
        redact,
        available
      );
      if (attachment) {
        attachments.push(attachment);
        total += attachment.bytes;
      }
    } catch {
      /* refuse unreadable or non-git paths */
    }
  }
  return attachments;
};

/** Reads exact tracked working-tree files only when explicitly enabled. */
export const readTrackedFiles = (
  cwd: string,
  requested: string[],
  enabled: boolean,
  redact: boolean,
  totalLimit = ADVISOR_FILES_TOTAL_MAX_BYTES
) => readFiles(cwd, requested, enabled, redact, "tracked", totalLimit);

/** Returns exact, permitted untracked regular-file bodies. Refusals are silent. */
export const readUntrackedFiles = (
  cwd: string,
  requested: string[],
  enabled: boolean,
  redact: boolean,
  totalLimit = ADVISOR_FILES_TOTAL_MAX_BYTES
) => readFiles(cwd, requested, enabled, redact, "untracked", totalLimit);

const readImageAttachment = async (
  root: string,
  name: string,
  mimeType: string,
  remaining: number
): Promise<ImageAttachment | undefined> => {
  const absolute = resolve(root, name);
  if (!within(root, absolute)) {
    return;
  }
  const stats = await lstat(absolute);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return;
  }
  const resolved = await realpath(absolute);
  if (!within(root, resolved)) {
    return;
  }
  const flags = constants.O_NOFOLLOW
    ? constants.O_RDONLY + constants.O_NOFOLLOW
    : constants.O_RDONLY;
  const file = await open(resolved, flags);
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.size > ADVISOR_IMAGE_MAX_BYTES ||
      opened.size > remaining
    ) {
      return;
    }
    const buffer = Buffer.alloc(opened.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== opened.size) {
      return;
    }
    const image = imageFromBytes(buffer.subarray(0, bytesRead), mimeType);
    return image ? { bytes: bytesRead, image, path: name } : undefined;
  } finally {
    await file.close();
  }
};

export const readImageFiles = async (
  cwd: string,
  requested: string[],
  enabled: boolean,
  kind: "tracked" | "untracked",
  remainingBytes: number,
  remainingCount: number
): Promise<{ images: ImageAttachment[]; omitted: number }> => {
  const names = Array.isArray(requested)
    ? requested.filter((path) => isString(path) && imageFileCandidate(path))
    : [];
  if (!enabled || !names.length) {
    return { images: [], omitted: names.length };
  }
  const root = await repositoryRoot(cwd);
  if (!root) {
    return { images: [], omitted: names.length };
  }
  const seen = new Set<string>();
  const images: ImageAttachment[] = [];
  let omitted = 0;
  let bytes = 0;
  for (const path of names) {
    const name = normalizeRequestedPath(root, path);
    if (name && seen.has(name)) {
      continue;
    }
    if (name) {
      seen.add(name);
    }
    try {
      const mime = name && imageMime(name);
      const image =
        name &&
        mime &&
        images.length < remainingCount &&
        remainingBytes - bytes > 0 &&
        isPermitted(root, name, kind)
          ? await readImageAttachment(root, name, mime, remainingBytes - bytes)
          : undefined;
      if (image) {
        images.push(image);
        bytes += image.bytes;
      } else {
        omitted += 1;
      }
    } catch {
      omitted += 1;
    }
  }
  return { images, omitted };
};
