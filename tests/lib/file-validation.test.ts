import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateFileBytes,
  isAllowedAvatarMime,
} from "../../lib/file-validation";

// Magic-byte prefixes for real files.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
function webp() {
  const b = Buffer.alloc(16);
  Buffer.from("RIFF").copy(b, 0);
  Buffer.from("WEBP").copy(b, 8);
  return b;
}

describe("validateFileBytes — magic-byte sniffing (anti-spoof)", () => {
  it("detects PNG / JPEG / GIF / PDF / ZIP by content, not by claimed type", () => {
    assert.equal(validateFileBytes(PNG, 1024).detectedMime, "image/png");
    assert.equal(validateFileBytes(JPEG, 1024).detectedMime, "image/jpeg");
    assert.equal(validateFileBytes(GIF, 1024).detectedMime, "image/gif");
    assert.equal(validateFileBytes(PDF, 1024).detectedMime, "application/pdf");
    assert.equal(validateFileBytes(ZIP, 1024).detectedMime, "application/zip");
    assert.equal(validateFileBytes(webp(), 1024).detectedMime, "image/webp");
  });

  it("THE attack: a ZIP claiming to be image/png is detected as zip, not png", () => {
    // Upload zip bytes but declare image/png — server must trust the bytes.
    const v = validateFileBytes(ZIP, 1024, "image/png");
    assert.equal(v.detectedMime, "application/zip");
    assert.equal(isAllowedAvatarMime(v.detectedMime), false);
  });

  it("RIFF without the WEBP tag is NOT classified as webp (avoids false image)", () => {
    const riffNotWebp = Buffer.alloc(16);
    Buffer.from("RIFF").copy(riffNotWebp, 0);
    Buffer.from("AVI ").copy(riffNotWebp, 8); // RIFF container, not WEBP
    const v = validateFileBytes(riffNotWebp, 1024);
    assert.notEqual(v.detectedMime, "image/webp");
  });

  it("flags oversized files before any sniffing", () => {
    const v = validateFileBytes(Buffer.alloc(2048), 1024);
    assert.equal(v.oversized, true);
    assert.equal(v.detectedMime, null);
  });

  it("treats printable/UTF-8 content as textual, binary as non-text", () => {
    const text = validateFileBytes(Buffer.from("# hello\nworld\n"), 1024, "text/markdown");
    assert.equal(text.textual, true);
    assert.equal(text.detectedMime, "text/markdown");
    // A run of NUL/control bytes is not textual.
    const binary = validateFileBytes(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x01]), 1024);
    assert.equal(binary.textual, false);
    assert.equal(binary.detectedMime, null);
  });

  it("falls back to text/plain for textual bytes with no declared mime", () => {
    const v = validateFileBytes(Buffer.from("plain text here"), 1024);
    assert.equal(v.textual, true);
    assert.equal(v.detectedMime, "text/plain");
  });

  it("handles tiny buffers shorter than any magic prefix without crashing", () => {
    const v = validateFileBytes(Buffer.from([0x89]), 1024);
    assert.equal(v.oversized, false);
    // One printable-ish byte → textual heuristic, not a crash.
    assert.ok(typeof v.textual === "boolean");
  });
});

describe("isAllowedAvatarMime", () => {
  it("allows png/jpeg/webp only", () => {
    assert.equal(isAllowedAvatarMime("image/png"), true);
    assert.equal(isAllowedAvatarMime("image/jpeg"), true);
    assert.equal(isAllowedAvatarMime("image/webp"), true);
    assert.equal(isAllowedAvatarMime("image/gif"), false);
    assert.equal(isAllowedAvatarMime("application/pdf"), false);
    assert.equal(isAllowedAvatarMime("application/zip"), false);
    assert.equal(isAllowedAvatarMime(null), false);
  });
});
