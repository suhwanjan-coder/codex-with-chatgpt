import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createSnapshot, snapshotDigest } from "../dist/review/snapshot.js";
import { prepareRemoteReview, remoteReviewDigest, validateRemoteReview } from "../dist/review/remote-permit.js";
import { ReviewSession } from "../dist/review/session.js";
import { startBridge } from "../dist/bridge/server.js";
import { CloudflaredQuickTunnel } from "../dist/tunnel/cloudflared.js";
import { nullLogger } from "../dist/logger/index.js";
import { assertKnownPilotSnapshot } from "./prepare-c2c-pilot.mjs";
import { createPilotInput } from "./pilot-input.mjs";

const repo = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const args = process.argv.slice(2);
if (args.length !== 5 || args[0] !== "--manifest" || args[2] !== "--model" || args[4] !== "--authorize-external-trial") {
  throw new Error("Usage: run-c2c-pilot.mjs --manifest <generated-manifest> --model <approved-model> --authorize-external-trial. The flag is an operator attestation, not proof of user consent.");
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(args[3])) throw new Error("INVALID_REMOTE_MODEL");
const { ensurePrivateDirectory, writePrivateNewFile } = await import("../dist/review/private-storage.js");

const manifestFile = path.resolve(args[1]);
const expectedParent = path.join(repo, ".tooling", "c2c-pilot");
const attemptDir = path.dirname(manifestFile);
if (path.dirname(attemptDir) !== expectedParent || !/^trial-[A-Za-z0-9]+$/.test(path.basename(attemptDir)) ||
    path.basename(manifestFile) !== "manifest.json") throw new Error("PILOT_GENERATED_MANIFEST_REQUIRED");
for (const file of [expectedParent, attemptDir, manifestFile]) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || fs.realpathSync.native(file) !== file || (stat.isFile() && (stat.nlink !== 1 || stat.size > 64 * 1024))) {
    throw new Error("PILOT_LINKED_OR_INVALID_INPUT");
  }
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const workspace = path.join(attemptDir, "repository");
const expectedPaths = ["discount-boundary", "pagination-offset", "extension-suffix"]
  .flatMap(id => [`${id}/src/index.mjs`, `${id}/test.mjs`]);
if (manifest.workspace !== workspace || JSON.stringify(manifest.reviewPaths) !== JSON.stringify(expectedPaths) ||
    manifest.realAdvisorTested !== false || manifest.externalTransmissionAuthorized !== false) {
  throw new Error("PILOT_MANIFEST_MISMATCH");
}
const binary = path.join(repo, ".tooling", "downloads", "cloudflared-2026.8.2-windows-amd64.exe");
const binaryHash = createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
if (binaryHash !== "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5") {
  throw new Error("PILOT_TUNNEL_BINARY_MISMATCH");
}
const snapshot = createSnapshot(workspace, {
  taskId: `c2c-${path.basename(attemptDir)}`, paths: expectedPaths, dataClass: "synthetic",
  ttlMs: 15 * 60_000, maxCalls: 30, maxOutputBytes: 512 * 1024,
});
assertKnownPilotSnapshot(snapshot);
if (snapshot.baseCommit !== manifest.baseCommit) throw new Error("PILOT_BASE_COMMIT_CHANGED");
const startFile = path.join(attemptDir, "run-start.json");
writePrivateNewFile(startFile, JSON.stringify({
  startedAt: new Date().toISOString(), snapshotDigest: snapshotDigest(snapshot),
  model: args[3], paths: expectedPaths, dataClass: "synthetic",
  operatorAttestation: true, realAdvisorTested: false,
}, null, 2));

const tunnel = new CloudflaredQuickTunnel(nullLogger, binary);
const closedOrigin = http.createServer((_req, res) => { res.writeHead(503); res.end(); });
let bridge;
let session;
let terminal;
let deadline;
let closing;
let remoteResource;
const closeHttp = server => new Promise(resolve => {
  if (!server.listening) return resolve();
  server.close(resolve);
  server.closeAllConnections();
});
const stop = () => {
  if (closing) return closing;
  let resolveClosing;
  closing = new Promise(resolve => { resolveClosing = resolve; });
  void (async () => {
    let failure;
    try {
      clearTimeout(deadline);
      if (terminal && !terminal.closed) terminal.close();
      await closeHttp(closedOrigin);
      try {
        if (bridge) await bridge.close();
        else { session?.close(); await tunnel.stop(); }
      } catch (error) { failure = error; process.exitCode = 1; }
    } catch (error) {
      failure = error;
      process.exitCode = 1;
    }
    try {
      writePrivateNewFile(path.join(attemptDir, "run-end.json"), JSON.stringify({
        endedAt: new Date().toISOString(), resource: remoteResource,
        cleanup: failure ? "FAILED" : "CLOSED", error: failure ? String(failure) : null,
        advisorResult: "NOT_AUTOMATICALLY_VERIFIED",
      }, null, 2));
      process.stdout.write(JSON.stringify({ event: "pilot_stopped", cleanup: failure ? "FAILED" : "CLOSED" }) + "\n");
    } catch (error) {
      process.exitCode = 1;
    } finally {
      resolveClosing();
    }
  })();
  return closing;
};
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });

try {
  await new Promise((resolve, reject) => {
    closedOrigin.once("error", reject);
    closedOrigin.listen(0, "127.0.0.1", resolve);
  });
  if (closing) throw new Error("PILOT_CANCELLED");
  const port = closedOrigin.address().port;
  deadline = setTimeout(() => { void stop(); }, Math.max(0, snapshot.expiresAt - Date.now()));
  // The public route only returns 503 until a destination-bound session is ready.
  const publicUrl = await tunnel.start(port);
  if (closing) throw new Error("PILOT_CANCELLED");
  remoteResource = `${publicUrl}/mcp`;
  const permit = prepareRemoteReview(snapshot, {
    model: args[3], resource: remoteResource,
    redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
  });
  const proposedDigest = remoteReviewDigest(permit);
  writePrivateNewFile(path.join(attemptDir, "remote-permit.json"), JSON.stringify(permit, null, 2));
  const snapshotFile = path.join(attemptDir, "snapshot.json");
  writePrivateNewFile(snapshotFile, JSON.stringify(snapshot, null, 2));
  terminal = readline.createInterface({ input: process.stdin });
  const input = createPilotInput({
    terminal,
    expectedDigest: proposedDigest,
    onStop: stop,
    onApprovalRejected: () => {
      process.stdout.write(JSON.stringify({ event: "approval_rejected" }) + "\n");
    },
  });
  process.stdout.write(JSON.stringify({
    event: "awaiting_scope_approval", resource: remoteResource, model: permit.model,
    permitDigest: proposedDigest, snapshotFile, paths: expectedPaths,
    expiresAt: snapshot.expiresAt, dataServiceEnabled: false,
  }) + "\n");
  const approvalDigest = await input.approval;
  validateRemoteReview(snapshot, permit, approvalDigest);
  if (closing) throw new Error("PILOT_CANCELLED");
  const stateDir = path.join(attemptDir, "state");
  ensurePrivateDirectory(stateDir);
  session = new ReviewSession(snapshot, { approvalDigest: snapshotDigest(snapshot), stateDir, idleMs: 300_000 });
  await closeHttp(closedOrigin);
  bridge = await startBridge({
    workspaceRoot: workspace, review: session, port, persistRuntime: false, tunnelProvider: tunnel,
    authStoreFile: session.authStoreFile,
    remoteReview: { snapshot, permit, approvalDigest },
  });
  if (closing || bridge.port !== port) {
    await bridge.close();
    throw new Error("PILOT_PORT_CHANGED_OR_CANCELLED");
  }
  const pairing = bridge.pairing.create();
  session.onClose(() => { void stop(); });
  process.stdout.write(JSON.stringify({
    event: "awaiting_chatgpt_connection", resource: remoteResource,
    pairingCode: pairing.code, expiresAt: snapshot.expiresAt,
    permitDigest: approvalDigest, auditFile: session.auditFile,
    realAdvisorTested: false,
  }) + "\n");
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(String(error) + "\n");
  await stop();
}
