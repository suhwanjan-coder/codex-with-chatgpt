import fs from "node:fs";
import path from "node:path";
import { request, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { nullLogger } from "../src/logger/index.js";
import { prepareRemoteReview, remoteReviewDigest, type RemoteReviewPermit } from "../src/review/remote-permit.js";
import { ReviewSession } from "../src/review/session.js";
import { createSnapshot, snapshotDigest, type ReviewSnapshot } from "../src/review/snapshot.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { cleanup, makeGitRepo, makeTmpDir, pkceVerifierAndChallenge, write } from "./helpers.js";

const RESOURCE = "https://synthetic-pilot.trycloudflare.com/mcp";
const PUBLIC_ORIGIN = "https://synthetic-pilot.trycloudflare.com";
const PUBLIC_HOST = "synthetic-pilot.trycloudflare.com";
const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";

const dirs: string[] = [];
const bridges: Bridge[] = [];
const sessions: ReviewSession[] = [];

class MockTunnel implements TunnelProvider {
  readonly name = "mock";
  starts = 0;
  stops = 0;
  constructor(private readonly failStop = false) {}
  async start(): Promise<string> { this.starts++; return RESOURCE.slice(0, -4); }
  async stop(): Promise<void> { this.stops++; if (this.failStop) throw new Error("mock stop failed"); }
  async restart(): Promise<string> { return this.start(); }
  status(): TunnelStatus { return { running: false, url: null, provider: this.name }; }
  getPublicUrl(): string | null { return null; }
  async doctor(): Promise<TunnelDoctorReport> {
    return { provider: this.name, binaryFound: true, binaryPath: "mock", running: false, url: null, problems: [] };
  }
}

function fixture(dataClass: "public" | "synthetic" | "non-sensitive" = "synthetic"): {
  root: string;
  snapshot: ReviewSnapshot;
  session: ReviewSession;
  permit: RemoteReviewPermit;
  approvalDigest: string;
} {
  const root = makeTmpDir("remote-bridge");
  const state = makeTmpDir("remote-bridge-state");
  dirs.push(root, state);
  makeGitRepo(root);
  const snapshot = createSnapshot(root, { taskId: "synthetic-pilot", paths: ["src/index.ts"], dataClass });
  const session = new ReviewSession(snapshot, { approvalDigest: snapshotDigest(snapshot), stateDir: state });
  sessions.push(session);
  const permit = prepareRemoteReview(snapshot, {
    model: "chatgpt-reviewer", resource: RESOURCE, redirectUri: REDIRECT_URI,
    ...(dataClass === "synthetic" ? {} : { reviewedSnapshotDigest: snapshotDigest(snapshot) }),
  });
  return { root, snapshot, session, permit, approvalDigest: remoteReviewDigest(permit) };
}

async function openRemote(test = fixture(), tunnel = new MockTunnel()): Promise<{ bridge: Bridge; base: string; test: ReturnType<typeof fixture>; tunnel: MockTunnel }> {
  const authDir = makeTmpDir("remote-bridge-auth");
  dirs.push(authDir);
  const bridge = await startBridge({
    workspaceRoot: test.root,
    review: test.session,
    remoteReview: { snapshot: test.snapshot, permit: test.permit, approvalDigest: test.approvalDigest },
    port: 0,
    persistRuntime: false,
    authStoreFile: test.session.authStoreFile,
    tunnelProvider: tunnel,
    logger: nullLogger,
  });
  bridges.push(bridge);
  return { bridge, base: bridge.localBaseUrl(), test, tunnel };
}

function headers(headers: Record<string, string> = {}): Record<string, string> {
  return { host: PUBLIC_HOST, ...headers };
}

interface LoopbackResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function loopback(base: string, route: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<LoopbackResponse> {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: target.port, path: route, method: opts.method ?? "GET", headers: opts.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(opts.body);
  });
}

function responseHeader(response: LoopbackResponse, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function register(base: string): Promise<string> {
  const response = await loopback(base, "/oauth/register", {
    method: "POST",
    headers: headers({ "content-type": "application/json", "x-forwarded-host": "attacker.example" }),
    body: JSON.stringify({ client_name: "synthetic-pilot", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  return (JSON.parse(response.body) as { client_id: string }).client_id;
}

async function authorize(base: string, bridge: Bridge, clientId: string): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkceVerifierAndChallenge();
  const authorizationUrl = new URL(`${base}/oauth/authorize`);
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("scope", "workspace.read git.read");
  authorizationUrl.searchParams.set("resource", RESOURCE);
  const page = await loopback(base, `${authorizationUrl.pathname}${authorizationUrl.search}`, { headers: headers() });
  expect(page.status).toBe(200);
  const requestId = page.body.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  expect(requestId).toBeTruthy();
  const paired = await loopback(base, "/oauth/authorize", {
    method: "POST",
    headers: headers({ "content-type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({ request_id: requestId!, pairing_code: bridge.pairing.create().code }).toString(),
  });
  const redirect = new URL(responseHeader(paired, "location"));
  expect(redirect.searchParams.get("iss")).toBe(`${PUBLIC_ORIGIN}/`);
  return { code: redirect.searchParams.get("code")!, verifier };
}

async function accessToken(base: string, clientId: string, code: string, verifier: string): Promise<string> {
  const response = await loopback(base, "/oauth/token", {
    method: "POST",
    headers: headers({ "content-type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier,
      redirect_uri: REDIRECT_URI, resource: RESOURCE,
    }).toString(),
  });
  expect(response.status).toBe(200);
  const body = JSON.parse(response.body) as { access_token: string; refresh_token?: string };
  expect(body.refresh_token).toBeUndefined();
  return body.access_token;
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => undefined);
  for (const session of sessions.splice(0)) session.close();
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("permit-bound remote review bridge", () => {
  it("uses the permit-bound public origin for discovery, OAuth and bearer challenges without starting a tunnel", async () => {
    const { bridge, base, test, tunnel } = await openRemote();
    const discovery = await loopback(base, "/.well-known/oauth-protected-resource/mcp", { headers: headers({ "x-forwarded-host": "attacker.example" }) });
    expect(JSON.parse(discovery.body)).toMatchObject({ resource: RESOURCE, authorization_servers: [`${PUBLIC_ORIGIN}/`] });
    const missingToken = await loopback(base, "/mcp", { method: "POST", headers: headers({ "content-type": "application/json" }), body: "{}" });
    expect(responseHeader(missingToken, "www-authenticate")).toContain(`${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    expect(tunnel.starts).toBe(0);

    const clientId = await register(base);
    const { code, verifier } = await authorize(base, bridge, clientId);
    const token = await accessToken(base, clientId, code, verifier);
    const info = await loopback(base, "/mcp", {
      method: "POST",
      headers: headers({ "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "review_info", arguments: {} } }),
    });
    const envelope = JSON.parse(info.body) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(envelope.result.content[0].text)).toMatchObject({
      remoteReview: { resource: RESOURCE, redirectUri: REDIRECT_URI, model: "chatgpt-reviewer", permitDigest: test.approvalDigest },
    });
    const audit = fs.readFileSync(test.session.auditFile, "utf8");
    expect(audit).toContain('"tool":"remote_review"');
    expect(audit).toContain(`"permitDigest":"${test.approvalDigest}"`);
  });

  it("accepts only the exact public host or local test host, and denies public health and admin routes", async () => {
    const { bridge, base } = await openRemote();
    const local = await loopback(base, "/.well-known/oauth-protected-resource/mcp", { headers: { host: `localhost:${bridge.port}`, origin: `http://127.0.0.1:${bridge.port}` } });
    expect(local.status).toBe(403);
    const localOrigin = await loopback(base, "/.well-known/oauth-protected-resource/mcp", { headers: { host: `localhost:${bridge.port}`, origin: `http://localhost:${bridge.port}` } });
    expect(localOrigin.status).toBe(200);
    expect((await loopback(base, "/.well-known/oauth-protected-resource/mcp", { headers: { host: "other.trycloudflare.com" } })).status).toBe(403);
    expect((await loopback(base, "/.well-known/oauth-protected-resource/mcp", { headers: headers({ origin: "https://attacker.example" }) })).status).toBe(403);
    expect((await loopback(base, "/health", { headers: headers({ authorization: "Bearer c2c_at_anything" }) })).status).toBe(404);
    expect((await loopback(base, "/HEALTH", { headers: headers() })).status).toBe(404);
    expect((await loopback(base, "/health/", { headers: headers() })).status).toBe(404);
    expect((await loopback(base, "/health", { headers: { host: `localhost:${bridge.port}`, "cf-connecting-ip": "203.0.113.7" } })).status).toBe(404);
    expect((await loopback(base, "/admin/tunnel/start", { method: "POST", headers: headers({ authorization: `Bearer ${bridge.adminToken}` }) })).status).toBe(404);
    expect((await loopback(base, "/ADMIN/info", { headers: { host: `localhost:${bridge.port}`, authorization: `Bearer ${bridge.adminToken}` } })).status).toBe(404);
  });

  it("exposes only the three read tools to a remote permit", async () => {
    const { bridge, base } = await openRemote();
    const clientId = await register(base);
    const { code, verifier } = await authorize(base, bridge, clientId);
    const token = await accessToken(base, clientId, code, verifier);
    const list = await loopback(base, "/mcp", {
      method: "POST",
      headers: headers({ "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const text = list.body;
    expect(text).toContain("review_info");
    expect(text).toContain("read_file");
    expect(text).toContain("review_diff");
    expect(text).not.toContain("review_complete");
  });

  it.each(["public", "non-sensitive"] as const)("reads only approved %s content through OAuth/MCP and revokes on close", async dataClass => {
    const { bridge, base, test } = await openRemote(fixture(dataClass));
    const clientId = await register(base);
    const { code, verifier } = await authorize(base, bridge, clientId);
    const token = await accessToken(base, clientId, code, verifier);
    const read = (file: string) => loopback(base, "/mcp", {
      method: "POST",
      headers: headers({ "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: file } } }),
    });
    expect((await read("src/index.ts")).body).toContain("answer = 42");
    expect((await read("hello.txt")).body).toContain("PATH_NOT_APPROVED");
    await bridge.close();
    expect(JSON.parse(fs.readFileSync(test.session.authStoreFile, "utf8")).tokens).toHaveLength(0);
    await expect(read("src/index.ts")).rejects.toThrow();
  });

  it("rejects an unattested public snapshot before creating a remote listener", async () => {
    const root = makeTmpDir("remote-bridge-public");
    const state = makeTmpDir("remote-bridge-public-state");
    const authDir = makeTmpDir("remote-bridge-public-auth");
    dirs.push(root, state, authDir);
    makeGitRepo(root);
    const snapshot = createSnapshot(root, { taskId: "public", paths: ["src/index.ts"], dataClass: "public" });
    const session = new ReviewSession(snapshot, { approvalDigest: snapshotDigest(snapshot), stateDir: state });
    sessions.push(session);
    const forged = {
      version: 1, provider: "chatgpt", transport: "cloudflare-quick", dataClass: "synthetic", model: "chatgpt-reviewer",
      resource: RESOURCE, redirectUri: REDIRECT_URI, snapshotDigest: snapshotDigest(snapshot), expiresAt: snapshot.expiresAt,
    } as RemoteReviewPermit;
    await expect(startBridge({
      workspaceRoot: root, review: session, remoteReview: { snapshot, permit: forged, approvalDigest: remoteReviewDigest(forged) },
      port: 0, persistRuntime: false, authStoreFile: session.authStoreFile, logger: nullLogger,
    })).rejects.toThrow("REMOTE_REVIEW_ATTESTATION_REQUIRED");
  });

  it("closes the listener even when tunnel teardown fails", async () => {
    const tunnel = new MockTunnel(true);
    const { bridge, base } = await openRemote(fixture(), tunnel);
    await expect(bridge.close()).rejects.toThrow("TUNNEL_STOP_FAILED");
    await expect(fetch(`${base}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(250) })).rejects.toThrow();
    expect(tunnel.stops).toBe(1);
  });

  it("rejects a permit whose snapshot digest does not match the attached session", async () => {
    const test = fixture();
    const authDir = makeTmpDir("remote-bridge-mismatch-auth");
    dirs.push(authDir);
    write(test.root, "src/index.ts", "export const changed = true;\n");
    const changed = createSnapshot(test.root, { taskId: "synthetic-pilot", paths: ["src/index.ts"], dataClass: "synthetic" });
    await expect(startBridge({
      workspaceRoot: test.root, review: test.session,
      remoteReview: { snapshot: changed, permit: test.permit, approvalDigest: test.approvalDigest },
      port: 0, persistRuntime: false, authStoreFile: test.session.authStoreFile, logger: nullLogger,
    })).rejects.toThrow();
  });
});
