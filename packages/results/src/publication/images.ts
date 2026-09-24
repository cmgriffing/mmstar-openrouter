/**
 * Content-addressed image extraction for a publication.
 *
 * The dataset remains the single committed image source: publication decodes
 * each selected fixture's original base64 bytes, validates the declared media
 * type against the actual magic number, hashes the *original* bytes, and writes
 * one file per unique hash under `benchmark-images/`. Two fixtures with
 * identical bytes reference one asset; the SQLite row stores the relative path
 * so the deployed website never needs a Git-host request at request time.
 *
 * Node/Bun only: this module touches the filesystem and node:crypto. The website
 * serves the files, it never calls this code.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublicationImageError } from "../errors";
import type { PublicationFixtureInput, PublicationImageAsset } from "./rows";
import { PUBLICATION_IMAGES_DIR, PUBLICATION_IMAGES_PREFIX } from "./schema";

/** Matches the dataset parser's decoded-image bound so publication cannot exceed it. */
export const PUBLICATION_IMAGE_LIMIT_BYTES = 8_000_000;

export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

const IMAGE_EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface WriteImageAssetsResult {
  /** One asset per fixture, in fixture-id order. */
  assets: PublicationImageAsset[];
  /** Unique files written (deduplicated by content hash). */
  fileCount: number;
  totalBytes: number;
}

/**
 * Decode and validate one fixture image. The media type must match the bytes;
 * a mismatch is a publication error rather than a guessed format.
 */
export function decodeImageBytes(
  mediaType: string,
  base64: string,
  fixtureId: string | null = null,
): Uint8Array {
  if (!isImageMediaType(mediaType)) {
    throw new PublicationImageError(
      `unsupported image media type ${JSON.stringify(mediaType)}`,
      fixtureId,
    );
  }
  if (base64 === "") {
    throw new PublicationImageError("image bytes are empty", fixtureId);
  }
  if (base64.length % 4 !== 0 || !BASE64_REGEX.test(base64)) {
    throw new PublicationImageError("image is not valid base64", fixtureId);
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const byteLength = (base64.length / 4) * 3 - padding;
  if (byteLength > PUBLICATION_IMAGE_LIMIT_BYTES) {
    throw new PublicationImageError(
      `image is ${byteLength} bytes; limit is ${PUBLICATION_IMAGE_LIMIT_BYTES}`,
      fixtureId,
    );
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength !== byteLength) {
    throw new PublicationImageError("image base64 decoded to an unexpected length", fixtureId);
  }
  if (!magicMatches(mediaType, bytes)) {
    throw new PublicationImageError(
      `image bytes do not match the declared media type ${mediaType}`,
      fixtureId,
    );
  }
  return bytes;
}

/** SHA-256 of original image bytes, hex encoded. */
export function imageSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function imageRelativePath(sha256: string, mediaType: ImageMediaType): string {
  return `${PUBLICATION_IMAGES_PREFIX}${sha256}.${IMAGE_EXTENSIONS[mediaType]}`;
}

/**
 * Write every fixture's image into `directory` (created if absent) and return
 * per-fixture assets. Identical bytes are written once.
 */
export function writeImageAssets(
  fixtures: readonly PublicationFixtureInput[],
  directory: string,
): WriteImageAssetsResult {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  const byHash = new Map<string, { path: string; byteLength: number }>();
  const assets: PublicationImageAsset[] = [];

  for (const fixture of fixtures) {
    const mediaType = fixture.image.mediaType;
    if (!isImageMediaType(mediaType)) {
      throw new PublicationImageError(
        `unsupported image media type ${JSON.stringify(mediaType)}`,
        fixture.fixtureId,
      );
    }
    const bytes = decodeImageBytes(mediaType, fixture.image.base64, fixture.fixtureId);
    const sha256 = imageSha256(bytes);
    let written = byHash.get(sha256);
    if (written === undefined) {
      const relativePath = imageRelativePath(sha256, mediaType);
      writeFileSync(join(directory, `${sha256}.${IMAGE_EXTENSIONS[mediaType]}`), bytes);
      written = { path: relativePath, byteLength: bytes.byteLength };
      byHash.set(sha256, written);
    }
    assets.push({
      fixtureId: fixture.fixtureId,
      sha256,
      relativePath: written.path,
      mediaType,
      byteLength: written.byteLength,
    });
  }

  let totalBytes = 0;
  for (const entry of byHash.values()) totalBytes += entry.byteLength;
  return { assets, fileCount: byHash.size, totalBytes };
}

/** Byte length on disk; used by verification to compare against the manifest. */
export function fileByteLength(path: string): number {
  return statSync(path).size;
}

export function isImageMediaType(value: string): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

export { PUBLICATION_IMAGES_DIR };

function magicMatches(mediaType: ImageMediaType, bytes: Uint8Array): boolean {
  const byte = (index: number): number => bytes[index] ?? -1;
  if (mediaType === "image/jpeg") {
    return byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff;
  }
  if (mediaType === "image/png") {
    return (
      byte(0) === 0x89 &&
      byte(1) === 0x50 &&
      byte(2) === 0x4e &&
      byte(3) === 0x47 &&
      byte(4) === 0x0d &&
      byte(5) === 0x0a &&
      byte(6) === 0x1a &&
      byte(7) === 0x0a
    );
  }
  return (
    byte(0) === 0x52 &&
    byte(1) === 0x49 &&
    byte(2) === 0x46 &&
    byte(3) === 0x46 &&
    byte(8) === 0x57 &&
    byte(9) === 0x45 &&
    byte(10) === 0x42 &&
    byte(11) === 0x50
  );
}
