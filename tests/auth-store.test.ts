import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStore } from "../src/auth/store.js";
import { cleanup, makeTmpDir, pkceVerifierAndChallenge } from "./helpers.js";

const dirs: string[] = [];
function fixture() {
  const dir = makeTmpDir("auth-store-boundaries");
  dirs.push(dir);
  const file = path.join(dir, "synthetic.json");
  return { file, store: new AuthStore("synthetic-workspace", { file }) };
}
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) cleanup(dir); });

describe("persisted synthetic OAuth credentials", () => {
  it("persists SHA-256 token hashes and bindings, never raw tokens or authorization codes", () => {
    const { store, file } = fixture();
    const { challenge } = pkceVerifierAndChallenge();
    const code = store.createAuthorizationCode({ clientId: "test-client", redirectUri: "http://127.0.0.1/cb",
      codeChallenge: challenge, scopes: ["workspace.read"], pairingSessionId: "synthetic-pairing" });
    const tokens = store.issueTokens({ clientId: "test-client", scopes: ["workspace.read", "offline_access"] });
    const text = fs.readFileSync(file, "utf8");
    const state = JSON.parse(text);
    expect(state.tokens).toHaveLength(2);
    for (const token of [tokens.accessToken, tokens.refreshToken!]) {
      expect(token).toMatch(/^c2c_(at|rt)_[A-Za-z0-9_-]{43}$/);
      expect(text).not.toContain(token);
      expect(state.tokens).toContainEqual(expect.objectContaining({
        hash: createHash("sha256").update(token).digest("hex"),
        clientId: "test-client", workspaceId: "synthetic-workspace", scopes: ["workspace.read", "offline_access"],
      }));
    }
    expect(text).not.toContain(code);
    const reloaded = new AuthStore("synthetic-workspace", { file });
    expect(reloaded.verifyAccessToken(tokens.accessToken).ok).toBe(true);
    expect(reloaded.consumeAuthorizationCode(code)).toBeNull();
  }, 9_000);

  it("expires default access tokens after one hour and refresh tokens after thirty days", () => {
    vi.useFakeTimers();
    const { store } = fixture();
    const started = Date.now();
    const tokens = store.issueTokens({ clientId: "test-client", scopes: ["offline_access"] });
    expect(tokens.expiresIn).toBe(3600);
    vi.setSystemTime(started + 3_600_000 - 1);
    expect(store.verifyAccessToken(tokens.accessToken).ok).toBe(true);
    vi.setSystemTime(started + 3_600_000 + 1);
    expect(store.verifyAccessToken(tokens.accessToken)).toEqual({ ok: false, reason: "expired" });
    vi.setSystemTime(started + 30 * 24 * 3_600_000 + 1);
    expect(store.refresh(tokens.refreshToken!, "test-client")).toEqual({ ok: false, reason: "invalid_grant" });
  }, 9_000);

  it("expires authorization codes after five minutes without allowing replay", () => {
    vi.useFakeTimers();
    const { store } = fixture();
    const input = { clientId: "test-client", redirectUri: "http://127.0.0.1/cb",
      codeChallenge: pkceVerifierAndChallenge().challenge, scopes: ["workspace.read"], pairingSessionId: "synthetic-pairing" };
    const usable = store.createAuthorizationCode(input);
    const expired = store.createAuthorizationCode(input);
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(store.consumeAuthorizationCode(usable)).toMatchObject(input);
    expect(store.consumeAuthorizationCode(usable)).toBeNull();
    vi.advanceTimersByTime(2);
    expect(store.consumeAuthorizationCode(expired)).toBeNull();
  }, 9_000);

  it("binds refresh to its client and preserves workspace and scopes during rotation", () => {
    const { store } = fixture();
    const tokens = store.issueTokens({ clientId: "owner", scopes: ["git.read", "offline_access"], workspaceId: "bound-workspace" });
    expect(store.verifyAccessToken(tokens.refreshToken!)).toEqual({ ok: false, reason: "wrong_kind" });
    expect(store.refresh(tokens.refreshToken!, "other")).toEqual({ ok: false, reason: "invalid_client" });
    const rotated = store.refresh(tokens.refreshToken!, "owner");
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error("rotation failed");
    expect(store.verifyAccessToken(rotated.tokens.accessToken)).toMatchObject({ ok: true, record: {
      clientId: "owner", workspaceId: "bound-workspace", scopes: ["git.read", "offline_access"],
    } });
    expect(store.refresh(tokens.refreshToken!, "owner").ok).toBe(false);
    expect(store.issueTokens({ clientId: "owner", scopes: ["workspace.read"] }).refreshToken).toBeNull();
  }, 9_000);

  it("revokes all credentials and pending codes durably across reload", () => {
    const { store, file } = fixture();
    const tokens = store.issueTokens({ clientId: "owner", scopes: ["offline_access"] });
    const code = store.createAuthorizationCode({ clientId: "owner", redirectUri: "http://127.0.0.1/cb",
      codeChallenge: pkceVerifierAndChallenge().challenge, scopes: [], pairingSessionId: "synthetic-pairing" });
    expect(store.revokeAll()).toBe(2);
    expect(store.consumeAuthorizationCode(code)).toBeNull();
    expect(store.verifyAccessToken(tokens.accessToken).ok).toBe(false);
    const reloaded = new AuthStore("synthetic-workspace", { file });
    expect(reloaded.tokenCount()).toBe(0);
    expect(reloaded.verifyAccessToken(tokens.accessToken).ok).toBe(false);
    expect(reloaded.refresh(tokens.refreshToken!, "owner").ok).toBe(false);
  }, 9_000);
});
