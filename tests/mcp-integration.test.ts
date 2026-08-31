import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { ReviewSession } from "../src/review/session.js";
import { createSnapshot, snapshotDigest, type ReviewSnapshot } from "../src/review/snapshot.js";
import { cleanup, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const REVIEW_TOOLS = ["read_file", "review_complete", "review_diff", "review_info"];
const LEGACY_TOOLS = [
  "workspace_info",
  "list_directory",
  "search_workspace",
  "git_status",
  "git_diff",
  "test_status",
  "execution_summary",
];

let root: string;
let stateDir: string;
let authDir: string;
let snapshot: ReviewSnapshot;
let approvedSnapshotText: string;
let approvedDigest: string;
let review: ReviewSession;
let bridge: Bridge;
let client: Client;

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[] | undefined;
  return content?.[0]?.text ?? "";
}

function jsonOf<T>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

function mcpRequestBody(): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
}

async function openClient(baseUrl: string, token: string, name: string): Promise<Client> {
  const next = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await next.connect(transport);
  return next;
}

beforeAll(async () => {
  root = makeTmpDir("mcp-review-root");
  makeGitRepo(root);
  write(root, "src/index.ts", "export const answer = 43;\n");
  write(root, ".env", "SECRET=do-not-leak\n");
  write(root, "package.json", JSON.stringify({ name: "fixture", scripts: { test: "secret-script" } }));
  write(root, "scripts/run.ts", "export const scriptMetadata = true;\n");

  snapshot = createSnapshot(root, { taskId: "mcp-review", paths: ["hello.txt", "src/index.ts"] });
  approvedSnapshotText = JSON.stringify(snapshot);
  approvedDigest = snapshotDigest(snapshot);
  stateDir = makeTmpDir("mcp-review-state");
  authDir = makeTmpDir("mcp-review-auth");
  review = new ReviewSession(snapshot, { approvalDigest: approvedDigest, stateDir });
  bridge = await startBridge({
    workspaceRoot: root,
    review,
    port: 0,
    persistRuntime: false,
  authStoreFile: review.authStoreFile,
  });

  const tokens = bridge.authStore.issueTokens({
    clientId: "mcp-integration",
    scopes: ["workspace.read", "git.read"],
  });
  expect(tokens.scopes).toEqual(["workspace.read", "git.read"]);
  client = await openClient(bridge.localBaseUrl(), tokens.accessToken, "mcp-integration-client");
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await bridge?.close().catch(() => undefined);
  cleanup(root);
  cleanup(stateDir);
  cleanup(authDir);
});

describe("narrowed MCP review adapter over loopback Streamable HTTP", () => {
  it("exposes exactly four review tools with untrusted-data descriptions", async () => {
    expect(snapshot.files.map((file) => file.path)).toEqual(["hello.txt", "src/index.ts"]);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...REVIEW_TOOLS].sort());
    expect(tools).toHaveLength(4);
    for (const tool of tools) expect(tool.description?.toLowerCase()).toContain("untrusted");
    expect(tools.find((tool) => tool.name === "review_diff")?.description).toContain("not a live git diff");

    for (const legacy of LEGACY_TOOLS) expect(tools.map((tool) => tool.name)).not.toContain(legacy);
    const unavailable = await client.callTool({ name: "workspace_info", arguments: {} });
    expect(unavailable.isError).toBe(true);
    expect(textOf(unavailable)).toContain("UNKNOWN_TOOL");
  });

  it("returns review metadata without root, scripts, or live workspace data", async () => {
    const result = await client.callTool({ name: "review_info", arguments: {} });
    const info = jsonOf<{
      taskId: string;
      snapshot: string;
      baseCommit: string;
      files: { path: string; beforeBytes: number; afterBytes: number }[];
      [key: string]: unknown;
    }>(result);

    expect(info.taskId).toBe("mcp-review");
    expect(info.snapshot).toBe(approvedDigest);
    expect(info.baseCommit).toBe(snapshot.baseCommit);
    expect(info.files.map((file) => file.path)).toEqual(["hello.txt", "src/index.ts"]);
    expect(JSON.stringify(info)).not.toContain(root);
    expect(JSON.stringify(info)).not.toContain("workspaceRoot");
    expect(JSON.stringify(info)).not.toContain("scripts");
    expect(JSON.stringify(info)).not.toContain("secret-script");
    expect(JSON.stringify(info)).not.toContain("do-not-leak");

    const invalid = await client.callTool({ name: "review_info", arguments: { unexpected: true } });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain("INVALID_ARGUMENTS");
  });

  it("reads only approved before/after pairs and rejects env and unapproved paths", async () => {
    const before = jsonOf<{ path: string; version: string; content: string }>(
      await client.callTool({ name: "read_file", arguments: { path: "src/index.ts", version: "before" } })
    );
    const after = jsonOf<{ path: string; version: string; content: string }>(
      await client.callTool({ name: "read_file", arguments: { path: "src/index.ts" } })
    );
    const diff = jsonOf<{
      path: string;
      before: string;
      after: string;
      baseCommit: string;
      format: string;
    }>(await client.callTool({ name: "review_diff", arguments: { path: "src/index.ts" } }));

    expect(before).toMatchObject({ path: "src/index.ts", version: "before", content: "export const answer = 42;\n" });
    expect(after).toMatchObject({ path: "src/index.ts", version: "after", content: "export const answer = 43;\n" });
    expect(diff).toEqual({
      path: "src/index.ts",
      before: "export const answer = 42;\n",
      after: "export const answer = 43;\n",
      baseCommit: snapshot.baseCommit,
      snapshot: approvedDigest,
      format: "before-after",
    });

    const env = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    expect(env.isError).toBe(true);
    expect(textOf(env)).toContain("PATH_NOT_APPROVED");
    expect(textOf(env)).not.toContain("do-not-leak");

    const unapproved = await client.callTool({ name: "read_file", arguments: { path: "package.json" } });
    expect(unapproved.isError).toBe(true);
    expect(textOf(unapproved)).toContain("PATH_NOT_APPROVED");

    const invalid = await client.callTool({
      name: "review_diff",
      arguments: { path: "src/index.ts", version: "after" },
    });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain("INVALID_ARGUMENTS");
  });

  it("keeps the approved snapshot stable after live writes", async () => {
    write(root, "hello.txt", "live hello should stay invisible\n");
    write(root, "src/index.ts", "export const answer = 9001;\n");
    write(root, ".env", "SECRET=changed-live-secret\n");
    write(root, "scripts/run.ts", "export const scriptMetadata = 'changed';\n");

    const after = jsonOf<{ content: string }>(
      await client.callTool({ name: "read_file", arguments: { path: "src/index.ts", version: "after" } })
    );
    const diff = jsonOf<{ before: string; after: string }>(
      await client.callTool({ name: "review_diff", arguments: { path: "src/index.ts" } })
    );

    expect(after.content).toBe("export const answer = 43;\n");
    expect(diff).toMatchObject({ before: "export const answer = 42;\n", after: "export const answer = 43;\n" });
    expect(JSON.stringify(snapshot)).toBe(approvedSnapshotText);
    expect(snapshotDigest(snapshot)).toBe(approvedDigest);
  });

  it("passes exact scopes to the review session", async () => {
    const workspaceOnly = bridge.authStore.issueTokens({ clientId: "workspace-only", scopes: ["workspace.read"] });
    expect(workspaceOnly.scopes).toEqual(["workspace.read"]);
    const workspaceClient = await openClient(bridge.localBaseUrl(), workspaceOnly.accessToken, "workspace-only-client");
    const deniedDiff = await workspaceClient.callTool({ name: "review_diff", arguments: { path: "src/index.ts" } });
    expect(deniedDiff.isError).toBe(true);
    expect(textOf(deniedDiff)).toContain("INSUFFICIENT_SCOPE");
    const allowedRead = await workspaceClient.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(allowedRead.isError ?? false).toBe(false);
    await workspaceClient.close();

    const gitOnly = bridge.authStore.issueTokens({ clientId: "git-only", scopes: ["git.read"] });
    expect(gitOnly.scopes).toEqual(["git.read"]);
    const gitClient = await openClient(bridge.localBaseUrl(), gitOnly.accessToken, "git-only-client");
    const deniedInfo = await gitClient.callTool({ name: "review_info", arguments: {} });
    expect(deniedInfo.isError).toBe(true);
    expect(textOf(deniedInfo)).toContain("INSUFFICIENT_SCOPE");
    const allowedDiff = await gitClient.callTool({ name: "review_diff", arguments: { path: "src/index.ts" } });
    expect(allowedDiff.isError ?? false).toBe(false);
    await gitClient.close();
  });

  it("returns 401 for missing and invalid bearer authentication", async () => {
    const url = `${bridge.localBaseUrl()}/mcp`;
    const missing = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: mcpRequestBody(),
    });
    expect(missing.status).toBe(401);
    expect(await missing.text()).toContain("Authentication required");

    const invalid = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer invalid-token", "content-type": "application/json" },
      body: mcpRequestBody(),
    });
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).toContain("Token unknown");
  });

  it("does not expose legacy repository tools without an approved review", async () => {
    const noReviewAuthDir = makeTmpDir("mcp-no-review-auth");
    const noReviewBridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(noReviewAuthDir, "store.json"),
    });
    const noReviewTokens = noReviewBridge.authStore.issueTokens({
      clientId: "no-review",
      scopes: ["workspace.read", "git.read"],
    });
    const noReviewClient = await openClient(noReviewBridge.localBaseUrl(), noReviewTokens.accessToken, "no-review-client");
    const { tools } = await noReviewClient.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names.sort()).toEqual([...REVIEW_TOOLS].sort());
    for (const legacy of LEGACY_TOOLS) expect(names).not.toContain(legacy);
    const denied = await noReviewClient.callTool({ name: "review_info", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("REVIEW_NOT_APPROVED");
    await noReviewClient.close();
    await noReviewBridge.close();
    cleanup(noReviewAuthDir);
  });

  it("completes the review only after the shared fixture assertions", async () => {
    const result = await client.callTool({ name: "review_complete", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    expect(jsonOf<{ completed: boolean; snapshot: string }>(result)).toEqual({
      completed: true,
      snapshot: approvedDigest,
    });
  });
});
