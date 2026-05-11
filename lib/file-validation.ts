import "server-only";

const MAGIC_BYTES: Array<{
  prefix: number[];
  mime: string;
  ext: string;
}> = [
  { prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png", ext: "png" },
  { prefix: [0xff, 0xd8, 0xff], mime: "image/jpeg", ext: "jpg" },
  { prefix: [0x47, 0x49, 0x46, 0x38], mime: "image/gif", ext: "gif" },
  { prefix: [0x52, 0x49, 0x46, 0x46], mime: "image/webp", ext: "webp" }, // RIFF then 'WEBP' at offset 8
  { prefix: [0x25, 0x50, 0x44, 0x46], mime: "application/pdf", ext: "pdf" },
  { prefix: [0x50, 0x4b, 0x03, 0x04], mime: "application/zip", ext: "zip" },
];

export type ValidatedFile = {
  detectedMime: string | null;
  textual: boolean;
  oversized: boolean;
};

export function validateFileBytes(
  bytes: Buffer,
  maxBytes: number,
  declaredMime?: string,
): ValidatedFile {
  if (bytes.length > maxBytes) {
    return { detectedMime: null, textual: false, oversized: true };
  }
  for (const m of MAGIC_BYTES) {
    if (bytes.length < m.prefix.length) continue;
    let ok = true;
    for (let i = 0; i < m.prefix.length; i++) {
      if (bytes[i] !== m.prefix[i]) { ok = false; break; }
    }
    if (ok) {
      if (m.mime === "image/webp") {
        // Check 'WEBP' at offset 8
        const tag = bytes.slice(8, 12).toString("utf8");
        if (tag !== "WEBP") continue;
      }
      return { detectedMime: m.mime, textual: false, oversized: false };
    }
  }
  // Heuristic: text if 95%+ printable ASCII or valid UTF-8 within first 4KB.
  const sample = bytes.slice(0, Math.min(bytes.length, 4096));
  let textChars = 0;
  for (const b of sample) {
    if (
      b === 0x09 || b === 0x0a || b === 0x0d ||
      (b >= 0x20 && b <= 0x7e) ||
      b >= 0x80 // possibly UTF-8
    ) {
      textChars++;
    }
  }
  const textual = sample.length > 0 && textChars / sample.length > 0.95;
  return {
    detectedMime: textual ? declaredMime ?? "text/plain" : null,
    textual,
    oversized: false,
  };
}

export function isAllowedAvatarMime(mime: string | null): boolean {
  return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp";
}
