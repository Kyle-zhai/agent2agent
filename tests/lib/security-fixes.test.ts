import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeNextPath } from "../../lib/auth";
import { oauthStateSecret } from "../../lib/oauth";
import { signGrantPayload } from "../../lib/crypto";

// Regression locks for the pre-push bug-hunt fixes.

describe("safeNextPath — open-redirect clamp", () => {
  it("keeps same-origin relative paths", () => {
    assert.equal(safeNextPath("/app/c/abc"), "/app/c/abc");
    assert.equal(safeNextPath("/settings"), "/settings");
  });
  it("rejects absolute URLs and scheme-relative / backslash tricks", () => {
    for (const bad of [
      "https://evil.com",
      "//evil.com",
      "/\\evil.com",
      "http://x",
      "javascript:alert(1)",
      undefined,
      "",
      "app", // missing leading slash
    ]) {
      assert.equal(safeNextPath(bad as string | undefined), "/app", `bad: ${bad}`);
    }
  });
});

describe("oauthStateSecret — fail closed in production", () => {
  const orig = process.env.NODE_ENV;
  const origSecret = process.env.SESSION_SECRET;
  it("returns the env secret when set", () => {
    process.env.SESSION_SECRET = "real-secret-value";
    try {
      assert.equal(oauthStateSecret(), "real-secret-value");
    } finally {
      if (origSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = origSecret;
    }
  });
  it("falls back to a dev literal only outside production", () => {
    delete process.env.SESSION_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "development";
    try {
      assert.equal(oauthStateSecret(), "dev-fallback-secret");
    } finally {
      (process.env as Record<string, string>).NODE_ENV = orig ?? "test";
      if (origSecret !== undefined) process.env.SESSION_SECRET = origSecret;
    }
  });
  it("throws in production when SESSION_SECRET is unset", () => {
    delete process.env.SESSION_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      assert.throws(() => oauthStateSecret(), /SESSION_SECRET must be set in production/);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = orig ?? "test";
      if (origSecret !== undefined) process.env.SESSION_SECRET = origSecret;
    }
  });
});

describe("grantSecret — fail closed in production", () => {
  const orig = process.env.NODE_ENV;
  const origGrant = process.env.A2A_GRANT_SECRET;
  it("signs with the derived secret outside production", () => {
    delete process.env.A2A_GRANT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "development";
    try {
      assert.equal(typeof signGrantPayload("v1:{}"), "string");
    } finally {
      (process.env as Record<string, string>).NODE_ENV = orig ?? "test";
      if (origGrant !== undefined) process.env.A2A_GRANT_SECRET = origGrant;
    }
  });
  it("throws in production when A2A_GRANT_SECRET is unset", () => {
    delete process.env.A2A_GRANT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      assert.throws(() => signGrantPayload("v1:{}"), /A2A_GRANT_SECRET must be set in production/);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = orig ?? "test";
      if (origGrant !== undefined) process.env.A2A_GRANT_SECRET = origGrant;
    }
  });
});
