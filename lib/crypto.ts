import "server-only";
import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";

const SCRYPT_KEYLEN = 64;

export function hashPassword(plain: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN).toString("hex");
  return { hash, salt };
}

export function verifyPassword(plain: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(plain, salt, SCRYPT_KEYLEN);
  const known = Buffer.from(hash, "hex");
  if (candidate.length !== known.length) return false;
  return timingSafeEqual(candidate, known);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256HexOfBuffer(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
