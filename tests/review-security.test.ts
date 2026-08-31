import express from "express";
import fs from "node:fs";
import path from "node:path";
import { request, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AuthStore } from "../src/auth/store.js";
import { createOAuthRouter } from "../src/auth/oauth.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { nullLogger } from "../src/logger/index.js";
import { PairingManager } from "../src/pairing/manager.js";
import { ReviewSession } from "../src/review/session.js";
import { createSnapshot, snapshotDigest, type ReviewSnapshot } from "../src/review/snapshot.js";
import type { TunnelProvider } from "../src/tunnel/provider.js";
import { cleanup, makeGitRepo, makeTmpDir, pkceVerifierAndChallenge, write } from "./helpers.js";

const dirs: string[] = [];
const bridges: Bridge[] = [];
const sessions: ReviewSession[] = [];
const servers: Server[] = [];
const REDIRECT_URI = "http://127.0.0.1:19999/callback";

function tmp(name: string): string {
  const dir = makeTmpDir(name);
  dirs.push(dir);
  return dir;
}

function json(response: Response): Promise<Record<string, string>> {
  return response.json() as Promise<Record<string, string>>;
}

async function unreachable(url: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(150) });
      last = new Error(`listener still returned ${response.status}`);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw last ?? new Error("listener remained reachable");
}

function loopbackGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: target.hostname, port: target.port, path: "/health", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end();
  });
}

function reviewFixture(opts: {
  idleMs?: number;
  now?: () => number;
  taskId?: string;
  maxCalls?: number;
  maxOutputBytes?: number;
} = {}): {
  root: string;
  snapshot: ReviewSnapshot;
  session: ReviewSession;
  authStoreFile: string;
} {
  const root = tmp("review-security-root");
  makeGitRepo(root);
  write(root, "src/index.ts", "export const answer = 43;\n");
  const snapshot = createSnapshot(root, {
    taskId: opts.taskId ?? "security-review",
    paths: ["src/index.ts"],
    ttlMs: 60_000,
    maxCalls: opts.maxCalls,
    maxOutputBytes: opts.maxOutputBytes,
  });
  const session = new ReviewSession(snapshot, {
    approvalDigest: snapshotDigest(snapshot),
    stateDir: tmp("review-security-state"),
    idleMs: opts.idleMs,
    now: opts.now,
  });
  sessions.push(session);
  return {
    root,
    snapshot,
    session,
    authStoreFile: session.authStoreFile,
  };
}

async function openReviewBridge(fixture = reviewFixture()): Promise<{ bridge: Bridge; base: string; fixture: ReturnType<typeof reviewFixture> }> {
  const bridge = await startBridge({
    workspaceRoot: fixture.root,
    review: fixture.session,
    port: 0,
    persistRuntime: false,
    authStoreFile: fixture.authStoreFile,
    logger: nullLogger,
  });
  bridges.push(bridge);
  return { bridge, base: bridge.localBaseUrl(), fixture };
}

async function register(base: string, redirectUri = REDIRECT_URI): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "review-security", redirect_uris: [redirectUri] }),
  });
  expect(response.status).toBe(201);
  return (await json(response)).client_id;
}

async function authorize(
  base: string,
  clientId: string,
  challenge: string,
  pairingCode: string,
  opts: { resource?: string | null; scope?: string; redirectUri?: string } = {},
): Promise<{ response: Response; code?: string }> {
  const redirectUri = opts.redirectUri ?? REDIRECT_URI;
  const request = new URL(`${base}/oauth/authorize`);
  request.searchParams.set("client_id", clientId);
  request.searchParams.set("redirect_uri", redirectUri);
  request.searchParams.set("response_type", "code");
  request.searchParams.set("code_challenge", challenge);
  request.searchParams.set("code_challenge_method", "S256");
  if (opts.resource !== null) request.searchParams.set("resource", opts.resource ?? `${base}/mcp`);
  request.searchParams.set("scope", opts.scope ?? "workspace.read git.read");
  const page = await fetch(request, { redirect: "manual" });
  if (page.status !== 200) return { response: page };
  const html = await page.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  expect(requestId).toBeTruthy();
  const response = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId!, pairing_code: pairingCode }),
    redirect: "manual",
  });
  const location = response.headers.get("location");
  return { response, code: location ? new URL(location).searchParams.get("code") ?? undefined : undefined };
}

async function exchange(
  base: string,
  clientId: string,
  code: string,
  verifier: string,
  resource: string | null = `${base}/mcp`,
): Promise<{ status: number; body: Record<string, string> }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
  if (resource !== null) body.set("resource", resource);
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: response.status, body: await json(response) };
}

async function issueReviewToken(base: string, bridge: Bridge): Promise<string> {
  const clientId = await register(base);
  const { verifier, challenge } = pkceVerifierAndChallenge();
  const pairing = bridge.pairing.create();
  const approved = await authorize(base, clientId, challenge, pairing.code);
  expect(approved.response.status).toBe(302);
  const token = await exchange(base, clientId, approved.code!, verifier);
  expect(token.status).toBe(200);
  expect(token.body.scope).toBe("workspace.read git.read");
  return token.body.access_token;
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => undefined);
  for (const session of sessions.splice(0)) session.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("isolated review OAuth and bridge security", () => {
  it("requires the exact loopback MCP resource at authorize and token exchange", async () => {
    const { bridge, base } = await openReviewBridge();
    const info = await fetch(`${base}/admin/info`, { headers: { authorization: `Bearer ${bridge.adminToken}` } });
    expect((await info.json()) as { workspaceName: string }).toMatchObject({ workspaceName: "Local isolated review" });
    const clientId = await register(base);
    const { verifier, challenge } = pkceVerifierAndChallenge();

    for (const resource of [null, `${base}/mcp/`, "http://127.0.0.1:1/mcp"]) {
      const pairing = bridge.pairing.create();
      const result = await authorize(base, clientId, challenge, pairing.code, { resource });
      expect(result.response.status).toBe(302);
      expect(result.response.headers.get("location")).toContain("error=invalid_target");
    }

    const pairing = bridge.pairing.create();
    const approved = await authorize(base, clientId, challenge, pairing.code);
    expect(approved.code).toBeTruthy();
    const missing = await exchange(base, clientId, approved.code!, verifier, null);
    expect(missing).toMatchObject({ status: 400, body: { error: "invalid_target" } });

    const retryPairing = bridge.pairing.create();
    const retry = await authorize(base, clientId, challenge, retryPairing.code);
    const wrong = await exchange(base, clientId, retry.code!, verifier, `${base}/mcp/`);
    expect(wrong).toMatchObject({ status: 400, body: { error: "invalid_target" } });
  });

  it("rejects review-disallowed scopes, refresh grants, and external redirect URIs", async () => {
    const { bridge, base } = await openReviewBridge();
    const clientId = await register(base);
    const { challenge } = pkceVerifierAndChallenge();
    for (const scope of ["workspace.read offline_access", "workspace.read unknown.scope"]) {
      const pairing = bridge.pairing.create();
      const response = await authorize(base, clientId, challenge, pairing.code, { scope });
      expect(response.response.status).toBe(302);
      expect(response.response.headers.get("location")).toContain("error=invalid_scope");
    }
    const external = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://attacker.example/callback"] }),
    });
    expect(external.status).toBe(400);
    const refresh = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "fake", client_id: clientId }),
    });
    expect(await json(refresh)).toEqual({ error: "unsupported_grant_type" });
  });

  it("returns generic non-leaking OAuth errors for malformed JSON and wrong-type POST fields", async () => {
    const { base } = await openReviewBridge();
    const sentinel = `${process.cwd()}-oauth-body-sentinel`;
    const invalidRequests: Array<{ url: string; body: string; error: string }> = [
      {
        url: `${base}/oauth/register`,
        body: '{"redirect_uris":[',
        error: "REQUEST_REJECTED",
      },
      {
        url: `${base}/oauth/token`,
        body: JSON.stringify({ grant_type: ["authorization_code"], code: sentinel }),
        error: "invalid_request",
      },
    ];
    for (const request of invalidRequests) {
      const response = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: request.body,
      });
      const text = await response.text();
      expect(response.status).toBe(400);
      expect(JSON.parse(text)).toEqual({ error: request.error });
      expect(text).not.toContain(sentinel);
      expect(text).not.toContain(process.cwd());
      expect(text).not.toMatch(/\b(?:SyntaxError|TypeError)\b|\n\s*at\s/);
    }
  });

  it("rejects repeated OAuth scope query parameters with a generic non-leaking error", async () => {
    const { base } = await openReviewBridge();
    const clientId = await register(base);
    const { challenge } = pkceVerifierAndChallenge();
    const request = new URL(`${base}/oauth/authorize`);
    request.searchParams.set("client_id", clientId);
    request.searchParams.set("redirect_uri", REDIRECT_URI);
    request.searchParams.set("response_type", "code");
    request.searchParams.set("code_challenge", challenge);
    request.searchParams.set("code_challenge_method", "S256");
    request.searchParams.set("resource", `${base}/mcp`);
    request.searchParams.append("scope", "workspace.read");
    request.searchParams.append("scope", "git.read");
    const response = await fetch(request, { redirect: "manual" });
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: "invalid_request" });
    expect(text).not.toContain(process.cwd());
    expect(text).not.toMatch(/\b(?:SyntaxError|TypeError)\b|\n\s*at\s/);
  });

  it("issues only the requested review scopes, revokes tokens on close, and closes the listener", async () => {
    const { bridge, base } = await openReviewBridge();
    const token = await issueReviewToken(base, bridge);
    expect(bridge.authStore.verifyAccessToken(token).ok).toBe(true);
    await bridge.close();
    expect(bridge.authStore.verifyAccessToken(token)).toMatchObject({ ok: false, reason: "unknown" });
    await unreachable(base);
  });

  it("uses a unique private auth workspace for every review digest", async () => {
    const first = reviewFixture({ taskId: "digest-one" });
    const openedFirst = await openReviewBridge(first);
    const oldToken = await issueReviewToken(openedFirst.base, openedFirst.bridge);
    const second = reviewFixture({ taskId: "digest-two" });
    const openedSecond = await openReviewBridge(second);

    expect(openedSecond.bridge.port).not.toBe(openedFirst.bridge.port);
    expect(openedSecond.bridge.authStore.workspaceId).not.toBe(openedFirst.bridge.authStore.workspaceId);
    expect(openedSecond.bridge.authStore.workspaceId).toContain(second.session.digest);
    const transferred = await fetch(`${openedSecond.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${oldToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(transferred.status).toBe(401);
  });

  it("rejects a review auth-store override outside the session private directory", async () => {
    const fixture = reviewFixture();
    const outside = path.join(tmp("review-auth-outside"), "auth.json");
    await expect(startBridge({
      workspaceRoot: fixture.root,
      review: fixture.session,
      port: 0,
      persistRuntime: false,
      authStoreFile: outside,
      logger: nullLogger,
    })).rejects.toThrow("REVIEW_AUTH_STORE_PATH");
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("expires idle review sessions by closing the port and revoking their tokens", async () => {
    let initial: number | undefined;
    let elapsed = 0;
    const fixture = reviewFixture({ idleMs: 10, now: () => (initial ??= Date.now()) + elapsed });
    const { bridge, base } = await openReviewBridge(fixture);
    const token = bridge.authStore.issueTokens({ clientId: "idle", scopes: ["workspace.read", "git.read"] }).accessToken;
    elapsed += 10;
    await unreachable(base);
    expect(bridge.authStore.verifyAccessToken(token)).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("closes the bridge when review_complete is invoked through MCP", async () => {
    const { bridge, base } = await openReviewBridge();
    const token = bridge.authStore.issueTokens({ clientId: "complete", scopes: ["workspace.read", "git.read"] }).accessToken;
    const client = new Client({ name: "review-complete-security", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const result = await client.callTool({ name: "review_complete", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    await client.close();
    await unreachable(base);
    expect(bridge.authStore.verifyAccessToken(token)).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("accounts and metadata-audits transport-rejected tool attempts without recording untrusted input", async () => {
    const { bridge, base, fixture } = await openReviewBridge(reviewFixture({ maxCalls: 2 }));
    const token = bridge.authStore.issueTokens({ clientId: "transport-audit", scopes: ["workspace.read", "git.read"] }).accessToken;
    const client = new Client({ name: "transport-audit-security", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);

    const unknownName = "unknown_tool_do_not_audit";
    const rawValue = "argument-value-do-not-audit";
    const unknown = await client.callTool({ name: unknownName, arguments: { value: rawValue } });
    const extraArgument = await client.callTool({ name: "review_info", arguments: { value: rawValue } });
    expect(unknown.isError ?? false).toBe(true);
    expect(extraArgument.isError ?? false).toBe(true);
    const budget = await client.callTool({ name: "review_info", arguments: {} });
    expect(budget.isError ?? false).toBe(true);
    expect(JSON.stringify(budget)).toContain("CALL_BUDGET_EXCEEDED");
    await client.close();

    const entries = fs.readFileSync(fixture.session.auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const attempts = entries.filter((entry) => !["session_start", "session_end", "protocol"].includes(entry.tool));
    const lifecycle = entries.filter((entry) => entry.tool === "session_start" || entry.tool === "session_end");
    expect(attempts).toEqual([
      expect.objectContaining({ tool: "unknown_tool", paths: [], outcome: "UNKNOWN_TOOL" }),
      expect.objectContaining({ tool: "review_info", paths: [], outcome: "INVALID_ARGUMENTS" }),
      expect.objectContaining({ tool: "review_info", paths: [], outcome: "CALL_BUDGET_EXCEEDED" }),
    ]);
    expect(lifecycle).toEqual([
      expect.objectContaining({ tool: "session_start", paths: [], outcome: "approved" }),
      expect.objectContaining({ tool: "session_end", paths: [], outcome: "budget" }),
    ]);
    expect(JSON.stringify(entries)).not.toContain(unknownName);
    expect(JSON.stringify(entries)).not.toContain(rawValue);
  });

  it("allows exactly 32 bounded tools/list protocol responses, then closes on the next response without data-tool execution", async () => {
    const { bridge, base, fixture } = await openReviewBridge();
    const token = bridge.authStore.issueTokens({ clientId: "protocol-cap", scopes: ["workspace.read", "git.read"] }).accessToken;
    const texts: string[] = [];
    for (let id = 1; id <= 32; id++) {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
      });
      const text = await response.text();
      expect(response.status).not.toBe(204);
      texts.push(text);
    }
    const terminal = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 33, method: "tools/list", params: {} }),
    });
    expect(terminal.status).toBe(204);
    expect(await terminal.text()).toBe("");
    expect(texts.join("\n")).not.toContain("export const answer = 43");

    const entries = fs.readFileSync(fixture.session.auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const protocol = entries.filter((entry) => entry.tool === "protocol");
    const dataTools = entries.filter((entry) => !["session_start", "session_end", "protocol"].includes(entry.tool));
    expect(protocol).toHaveLength(33);
    expect(protocol.slice(0, 32).every((entry) => entry.outcome === "ok" && entry.bytes > 0)).toBe(true);
    expect(protocol.at(-1)).toMatchObject({ outcome: "PROTOCOL_BUDGET_EXCEEDED", bytes: 0 });
    expect(dataTools).toEqual([]);
    expect(entries.at(-1)).toMatchObject({ tool: "session_end", outcome: "budget" });
    await unreachable(base);
  });

  it.each(["GET", "DELETE"])("accounts %s protocol 405 responses and suppresses the 33rd without data-tool execution", async (method) => {
    const { bridge, base, fixture } = await openReviewBridge();
    const token = bridge.authStore.issueTokens({ clientId: `protocol-${method.toLowerCase()}`, scopes: ["workspace.read", "git.read"] }).accessToken;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST." },
      id: null,
    });
    for (let index = 0; index < 32; index++) {
      const response = await fetch(`${base}/mcp`, { method, headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(405);
      expect(await response.text()).toBe(payload);
    }
    const terminal = await fetch(`${base}/mcp`, { method, headers: { authorization: `Bearer ${token}` } });
    expect(terminal.status).toBe(204);
    expect(await terminal.text()).toBe("");

    const entries = fs.readFileSync(fixture.session.auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const protocol = entries.filter((entry) => entry.tool === "protocol");
    const dataTools = entries.filter((entry) => !["session_start", "session_end", "protocol"].includes(entry.tool));
    expect(protocol).toHaveLength(33);
    expect(protocol.slice(0, 32)).toEqual(Array.from({ length: 32 }, () => expect.objectContaining({ outcome: "ok", bytes: Buffer.byteLength(payload) })));
    expect(protocol.at(-1)).toMatchObject({ outcome: "PROTOCOL_BUDGET_EXCEEDED", bytes: 0 });
    expect(dataTools).toEqual([]);
    expect(entries.at(-1)).toMatchObject({ tool: "session_end", outcome: "budget" });
    expect(JSON.stringify(entries)).not.toContain("export const answer = 43");
    await unreachable(base);
  });

  it("rejects single and mixed JSON-RPC batches through the shared audit and call budget without echoing raw entries", async () => {
    const { bridge, base, fixture } = await openReviewBridge(reviewFixture({ maxCalls: 2 }));
    const token = bridge.authStore.issueTokens({ clientId: "batch-audit", scopes: ["workspace.read", "git.read"] }).accessToken;
    const rawName = "batch-tool-name-do-not-echo";
    const rawValue = "batch-argument-do-not-echo";
    const post = async (body: unknown): Promise<{ status: number; text: string }> => {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    };

    const single = await post([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: rawName, arguments: { value: rawValue } } }]);
    const mixed = await post([
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "review_info", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: rawName, arguments: { value: rawValue } } },
    ]);
    for (const response of [single, mixed]) {
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
      expect(response.text).not.toContain(rawName);
      expect(response.text).not.toContain(rawValue);
    }
    const overflow = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "review_info", arguments: {} } });
    expect(overflow.text).toContain("CALL_BUDGET_EXCEEDED");

    const entries = fs.readFileSync(fixture.session.auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const attempts = entries.filter((entry) => entry.tool !== "session_start" && entry.tool !== "session_end");
    expect(attempts).toEqual([
      expect.objectContaining({ tool: "unknown_tool", paths: [], outcome: "UNKNOWN_TOOL" }),
      expect.objectContaining({ tool: "unknown_tool", paths: [], outcome: "UNKNOWN_TOOL" }),
      expect.objectContaining({ tool: "review_info", paths: [], outcome: "CALL_BUDGET_EXCEEDED" }),
    ]);
    expect(entries.at(-1)).toMatchObject({ tool: "session_end", paths: [], outcome: "budget" });
    expect(JSON.stringify(entries)).not.toContain(rawName);
    expect(JSON.stringify(entries)).not.toContain(rawValue);
  });

  it("refuses JSON-RPC ids longer than 128 bytes without echoing the id or tool payload", async () => {
    const { bridge, base, fixture } = await openReviewBridge();
    const token = bridge.authStore.issueTokens({ clientId: "long-id", scopes: ["workspace.read", "git.read"] }).accessToken;
    const longId = "i".repeat(129);
    const rawName = "long-id-tool-do-not-echo";
    const rawValue = "long-id-value-do-not-echo";
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: longId, method: "tools/call", params: { name: rawName, arguments: { value: rawValue } } }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    expect(text).not.toContain(longId);
    expect(text).not.toContain(rawName);
    expect(text).not.toContain(rawValue);
    const entries = fs.readFileSync(fixture.session.auditFile, "utf8");
    expect(entries).toContain('"tool":"unknown_tool"');
    expect(entries).not.toContain(longId);
    expect(entries).not.toContain(rawName);
    expect(entries).not.toContain(rawValue);
  });

  it("charges the full JSON-RPC envelope for an allowed 128-byte id and never emits more wire bytes than its output cap", async () => {
    const cap = 300;
    const { bridge, base, fixture } = await openReviewBridge(reviewFixture({ maxCalls: 2, maxOutputBytes: cap }));
    const token = bridge.authStore.issueTokens({ clientId: "wire-cap", scopes: ["workspace.read", "git.read"] }).accessToken;
    const id = "i".repeat(128);
    const rawName = "wire-cap-tool-do-not-echo";
    const rawValue = "wire-cap-value-do-not-echo";
    const post = async (requestId: string): Promise<{ status: number; text: string }> => {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name: rawName, arguments: { value: rawValue } } }),
      });
      return { status: response.status, text: await response.text() };
    };
    const successful = await post(id);
    const terminal = await post("second");
    const allResponses = [successful, terminal];
    const totalWireBytes = allResponses.reduce((total, response) => total + Buffer.byteLength(response.text), 0);

    expect(successful.status).toBe(200);
    expect(JSON.parse(successful.text)).toMatchObject({ jsonrpc: "2.0", id, result: { isError: true } });
    expect(terminal).toEqual({ status: 204, text: "" });
    expect(totalWireBytes).toBeLessThanOrEqual(cap);
    expect(successful.text).not.toContain(rawName);
    expect(successful.text).not.toContain(rawValue);
    const entries = fs.readFileSync(fixture.session.auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.slice(1)).toEqual([
      expect.objectContaining({ tool: "unknown_tool", outcome: "UNKNOWN_TOOL" }),
      expect.objectContaining({ tool: "unknown_tool", outcome: "OUTPUT_BUDGET_EXCEEDED", bytes: 0 }),
      expect.objectContaining({ tool: "session_end", outcome: "budget" }),
    ]);
    expect(JSON.stringify(entries)).not.toContain(rawName);
    expect(JSON.stringify(entries)).not.toContain(rawValue);
  });

  it("metadata-audits malformed MCP envelopes, consumes their budget, and returns a generic error", async () => {
    const { bridge, base, fixture } = await openReviewBridge(reviewFixture({ maxCalls: 1 }));
    const token = bridge.authStore.issueTokens({ clientId: "malformed-audit", scopes: ["workspace.read", "git.read"] }).accessToken;
    const rawName = "malformed-tool-name-do-not-audit";
    const rawValue = "malformed-value-do-not-audit";
    const malformed = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: null,
        method: "tools/call",
        params: { name: rawName, arguments: { value: rawValue } },
      }),
    });
    expect(malformed.status).toBe(200);
    expect(await malformed.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request" },
    });
    const budget = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "review_info", arguments: {} } }),
    });
    expect(await budget.text()).toContain("CALL_BUDGET_EXCEEDED");

    const entries = fs.readFileSync(fixture.session.auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries[1]).toMatchObject({ tool: "unknown_tool", paths: [], outcome: "UNKNOWN_TOOL" });
    expect(JSON.stringify(entries)).not.toContain(rawName);
    expect(JSON.stringify(entries)).not.toContain(rawValue);
  });

  it("rejects hostile Host, Origin, forwarded, and Cloudflare headers before routing", async () => {
    const { base } = await openReviewBridge();
    const cases: Array<Record<string, string>> = [
      { host: "attacker.example" },
      { origin: "http://attacker.example" },
      { forwarded: "for=192.0.2.1" },
      { "x-forwarded-host": "attacker.example" },
      { "cf-connecting-ip": "192.0.2.1" },
    ];
    for (const headers of cases) {
      const response = await loopbackGet(base, headers);
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: "LOCAL_REVIEW_ONLY" });
    }
  });

  it("returns 403 for the public tunnel admin route without starting a provider", async () => {
    const fixture = reviewFixture();
    let starts = 0;
    const tunnel: TunnelProvider = {
      name: "fake",
      start: async () => { starts++; return "https://attacker.example"; },
      stop: async () => undefined,
      restart: async () => { starts++; return "https://attacker.example"; },
      status: () => ({ running: false, url: null, provider: "fake" }),
      getPublicUrl: () => null,
      doctor: async () => ({ provider: "fake", binaryFound: false, binaryPath: null, running: false, url: null, problems: [] }),
    };
    const bridge = await startBridge({
      workspaceRoot: fixture.root,
      review: fixture.session,
      port: 0,
      persistRuntime: false,
      authStoreFile: fixture.authStoreFile,
      tunnelProvider: tunnel,
    });
    bridges.push(bridge);
    const response = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.adminToken}` },
    });
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: "PUBLIC_TUNNEL_DISABLED" });
    expect(starts).toBe(0);
  });

  it("keeps access tokens and snapshot contents out of the metadata-only audit", async () => {
    const { bridge, fixture } = await openReviewBridge();
    const token = bridge.authStore.issueTokens({ clientId: "audit", scopes: ["workspace.read", "git.read"] }).accessToken;
    fixture.session.invoke("read_file", { path: "src/index.ts" }, ["workspace.read"]);
    const audit = fs.readFileSync(fixture.session.auditFile, "utf8");
    expect(audit).toContain('"paths":["src/index.ts"]');
    expect(audit).not.toContain(token);
    expect(audit).not.toContain("export const answer = 43");
    expect(audit).not.toContain(fixture.root);
  });

  it("escapes untrusted workspace names in a direct OAuth pairing page while bridge names remain constant", async () => {
    const app = express();
    const store = new AuthStore("escape-test", { file: path.join(tmp("oauth-page-auth"), "store.json") });
    const pairing = new PairingManager("escape-test");
    app.use(createOAuthRouter({
      store,
      pairing,
      workspaceName: '<img src=x onerror="alert(1)">',
      getBaseUrl: () => "http://127.0.0.1:0",
      logger: nullLogger,
    }));
    const server = await new Promise<Server>((resolve) => {
      const next = app.listen(0, "127.0.0.1", () => resolve(next));
    });
    servers.push(server);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const client = store.registerClient({ clientName: "escape", redirectUris: ["https://example.test/callback"] });
    const { challenge } = pkceVerifierAndChallenge();
    const page = await fetch(`http://127.0.0.1:${port}/oauth/authorize?${new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: "https://example.test/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
    })}`);
    const html = await page.text();
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
  });
});
