import { createHash } from "node:crypto";

import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AdvisorToolPolicies } from "./config/types.ts";
import { contentParts, isRecordOf, isString } from "./content-utils.ts";
import type { RecordValue } from "./content-utils.ts";

export const ADVISOR_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const ADVISOR_IMAGES_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
export const ADVISOR_IMAGES_MAX_COUNT = 4;

const isPng = (bytes: Buffer) =>
  bytes.length >= 45 &&
  bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
  bytes.readUInt32BE(8) === 13 &&
  bytes.toString("ascii", 12, 16) === "IHDR" &&
  bytes.readUInt32BE(16) > 0 &&
  bytes.readUInt32BE(20) > 0 &&
  bytes.readUInt32BE(bytes.length - 12) === 0 &&
  bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND";

const isJpeg = (bytes: Buffer) =>
  bytes.length >= 4 &&
  bytes[0] === 0xff &&
  bytes[1] === 0xd8 &&
  bytes[2] === 0xff &&
  bytes.at(-2) === 0xff &&
  bytes.at(-1) === 0xd9;

const isGif = (bytes: Buffer) =>
  bytes.length >= 14 &&
  ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) &&
  bytes.readUInt16LE(6) > 0 &&
  bytes.readUInt16LE(8) > 0 &&
  bytes.at(-1) === 0x3b;

const isWebp = (bytes: Buffer) =>
  bytes.length >= 16 &&
  bytes.toString("ascii", 0, 4) === "RIFF" &&
  bytes.toString("ascii", 8, 12) === "WEBP" &&
  bytes.readUInt32LE(4) === bytes.length - 8 &&
  ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16));

const imageFormat = (bytes: Buffer): string | undefined => {
  if (isPng(bytes)) {
    return "image/png";
  }
  if (isJpeg(bytes)) {
    return "image/jpeg";
  }
  if (isGif(bytes)) {
    return "image/gif";
  }
  if (isWebp(bytes)) {
    return "image/webp";
  }
};

export const imageFromBytes = (
  bytes: Buffer,
  mimeType?: string
): ImageContent | undefined => {
  if (!bytes.length || bytes.length > ADVISOR_IMAGE_MAX_BYTES) {
    return;
  }
  const actual = imageFormat(bytes);
  if (!actual || (mimeType && mimeType !== actual)) {
    return;
  }
  return { data: bytes.toString("base64"), mimeType: actual, type: "image" };
};

export const imageFromPart = (part: RecordValue): ImageContent | undefined => {
  if (
    part.type !== "image" ||
    !isString(part.data) ||
    !isString(part.mimeType) ||
    part.data.length > Math.ceil((ADVISOR_IMAGE_MAX_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      part.data
    )
  ) {
    return;
  }
  const bytes = Buffer.from(part.data, "base64");
  if (bytes.toString("base64") !== part.data) {
    return;
  }
  return imageFromBytes(bytes, part.mimeType);
};

export const imageMarker = (
  part: RecordValue,
  nonce = ""
): string | undefined => {
  if (part.type !== "image") {
    return;
  }
  const image = imageFromPart(part);
  if (!image) {
    return "[Image omitted: unsupported format, invalid data, or over 4 MiB; pixels not reviewed]";
  }
  const id = createHash("sha256")
    .update(nonce)
    .update(image.data)
    .digest("hex")
    .slice(0, 24);
  return `[Image ref=img_${id}; pixels reviewed only if attached below]`;
};

export interface SelectedImage {
  image: ImageContent;
  marker: string;
}

export const selectedConversationImages = (
  ctx: ExtensionContext,
  conversation: string,
  policies: AdvisorToolPolicies,
  scoutSelected: boolean,
  nonce: string
): SelectedImage[] => {
  if (!conversation) {
    return [];
  }
  const entries = scoutSelected
    ? ctx.sessionManager.buildContextEntries()
    : ctx.sessionManager.getBranch();
  const images: SelectedImage[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }
    const { message } = entry;
    if (message.role !== "user" && message.role !== "toolResult") {
      continue;
    }
    if (
      message.role === "toolResult" &&
      (policies[message.toolName] ?? "full") !== "full"
    ) {
      continue;
    }
    for (const part of contentParts(message.content)) {
      if (!isRecordOf(part)) {
        continue;
      }
      const marker = imageMarker(part, nonce);
      if (!marker || seen.has(marker) || !conversation.includes(marker)) {
        continue;
      }
      const image = imageFromPart(part);
      if (image) {
        seen.add(marker);
        images.push({ image, marker });
      }
    }
  }
  return images;
};
