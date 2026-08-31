import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseSnapshot, snapshotDigest } from "../dist/review/snapshot.js";
import { prepareRemoteReview, remoteReviewDigest, validateRemoteReview } from "../dist/review/remote-permit.js";
import { ReviewSession } from "../dist/review/session.js";
import { ensurePrivateDirectory, writePrivateNewFile } from "../dist/review/private-storage.js";
import { startBridge } from "../dist/bridge/server.js";
import { CloudflaredQuickTunnel } from "../dist/tunnel/cloudflared.js";
import { nullLogger } from "../dist/logger/index.js";
import { createPilotInput } from "./pilot-input.mjs";

const REPO_ROOT = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const IDLE_MS = 300_000;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const CLOUD_FLARED_BINARY = path.join(REPO_ROOT, ".tooling", "downloads", "cloudflared-2026.8.2-windows-amd64.exe");
const CLOUD_FLARED_SHA256 = "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5";

function usageError() {
  return new Error("Usage: run-c2c.mjs --snapshot <prepared-snapshot> --model <approved-model> --state-dir <outside-reviewed-root> --authorize-external-review --reviewed-snapshot <snapshot-sha256>");
}

function isOutside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

function readPreparedSnapshot(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_SNAPSHOT_BYTES) {
    throw new Error("INVALID_SNAPSHOT_FILE");
  }
  return parseSnapshot(JSON.parse(fs.readFileSync(file, "utf8")));
}

function assertExistingStatePathOutside(root, stateDir) {
  const resolved = path.resolve(stateDir);
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (fs.existsSync(existing) && fs.lstatSync(existing).isSymbolicLink()) throw new Error("LINKED_STATE_DIRECTORY");
  const canonicalExisting = fs.existsSync(existing) ? fs.realpathSync.native(existing) : existing;
  const canonicalState = path.join(canonicalExisting, path.relative(existing, resolved));
  if (!isOutside(path.resolve(root), canonicalState)) throw new Error("STATE_INSIDE_REVIEW_ROOT");
  return canonicalState;
}

function assertPinnedTunnelBinary() {
  const hash = createHash("sha256").update(fs.readFileSync(CLOUD_FLARED_BINARY)).digest("hex");
  if (hash !== CLOUD_FLARED_SHA256) throw new Error("C2C_TUNNEL_BINARY_MISMATCH");
}

function closeHttp(server) {
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(resolve);
    server.closeAllConnections();
  });
}

/** Parse the exact operator-attested C2C runner command without starting a service. */
export function parseC2cRunArgs(args) {
  if (!Array.isArray(args) || args.length !== 9 ||
      args[0] !== "--snapshot" || args[2] !== "--model" || args[4] !== "--state-dir" ||
      args[6] !== "--authorize-external-review" || args[7] !== "--reviewed-snapshot") {
    throw usageError();
  }
  const [snapshotFile, model, stateDir, reviewedSnapshot] = [args[1], args[3], args[5], args[8]];
  if (typeof snapshotFile !== "string" || snapshotFile.length === 0 || typeof stateDir !== "string" || stateDir.length === 0) throw usageError();
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) throw new Error("INVALID_REMOTE_MODEL");
  if (typeof reviewedSnapshot !== "string" || !/^[a-f0-9]{64}$/.test(reviewedSnapshot)) throw new Error("INVALID_REVIEWED_SNAPSHOT_DIGEST");
  return Object.freeze({ snapshotFile: path.resolve(snapshotFile), model, stateDir: path.resolve(stateDir), reviewedSnapshot, authorizeExternalReview: true });
}

/**
 * Validate only the prepared immutable snapshot and local paths. This intentionally
 * does not inspect the reviewed repository or construct any listener/tunnel.
 */
export function preflightC2cRun(options, now = Date.now()) {
  if (!options || options.authorizeExternalReview !== true) throw new Error("C2C_EXTERNAL_REVIEW_NOT_AUTHORIZED");
  const snapshot = readPreparedSnapshot(options.snapshotFile);
  const digest = snapshotDigest(snapshot);
  if (snapshot.dataClass === undefined) throw new Error("C2C_UNCLASSIFIED_SNAPSHOT");
  if (snapshot.dataClass !== "public" && snapshot.dataClass !== "non-sensitive") throw new Error("C2C_REAL_SNAPSHOT_REQUIRED");
  if (digest !== options.reviewedSnapshot) throw new Error("C2C_REVIEWED_SNAPSHOT_MISMATCH");
  if (now < snapshot.createdAt || now >= snapshot.expiresAt) throw new Error("SNAPSHOT_EXPIRED");
  if (snapshot.expiresAt - now < IDLE_MS) throw new Error("C2C_SNAPSHOT_TTL_TOO_SHORT");
  const stateDir = assertExistingStatePathOutside(snapshot.root, options.stateDir);
  return Object.freeze({ ...options, stateDir, snapshot, digest });
}

function defaultDependencies(overrides = {}) {
  return {
    assertPinnedTunnelBinary,
    ensurePrivateDirectory,
    writePrivateNewFile,
    createTunnel: binary => new CloudflaredQuickTunnel(nullLogger, binary),
    createClosedOrigin: () => http.createServer((_req, res) => { res.writeHead(503); res.end(); }),
    createTerminal: () => readline.createInterface({ input: process.stdin }),
    createInput: createPilotInput,
    createSession: (snapshot, sessionOptions) => new ReviewSession(snapshot, sessionOptions),
    startBridge,
    writeOutput: text => process.stdout.write(text),
    writeError: text => process.stderr.write(text),
    processRef: process,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    ...overrides,
  };
}

/** Run one approved public or non-sensitive C2C snapshot review. */
export async function runC2c(options, overrides = {}) {
  const dependencies = defaultDependencies(overrides);
  const prepared = preflightC2cRun(options);
  dependencies.assertPinnedTunnelBinary();

  dependencies.ensurePrivateDirectory(prepared.stateDir);
  const receiptParent = dependencies.ensurePrivateDirectory(path.join(prepared.stateDir, ".c2c-external-review"));
  const receiptDir = dependencies.ensurePrivateDirectory(path.join(receiptParent, prepared.digest));
  const receipt = name => path.join(receiptDir, name);
  dependencies.writePrivateNewFile(receipt("snapshot.json"), JSON.stringify(prepared.snapshot, null, 2));
  dependencies.writePrivateNewFile(receipt("run-start.json"), JSON.stringify({
    startedAt: new Date().toISOString(), snapshotDigest: prepared.digest, model: prepared.model,
    dataClass: prepared.snapshot.dataClass, reviewedSnapshotDigest: prepared.reviewedSnapshot,
    operatorAttestation: true,
  }, null, 2));

  const tunnel = dependencies.createTunnel(CLOUD_FLARED_BINARY);
  const closedOrigin = dependencies.createClosedOrigin();
  let bridge;
  let session;
  let terminal;
  let deadline;
  let closing;
  let remoteResource;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const onSigint = () => { void stop(); };
  const onSigterm = () => { void stop(); };

  const stop = () => {
    if (closing) return closing;
    let resolveClosing;
    closing = new Promise(resolve => { resolveClosing = resolve; });
    void (async () => {
      const failures = [];
      const attempt = async action => {
        try { await action(); } catch (error) { failures.push(error); }
      };
      await attempt(() => dependencies.clearTimer(deadline));
      await attempt(() => terminal && !terminal.closed ? terminal.close() : undefined);
      await attempt(() => closeHttp(closedOrigin));
      await attempt(() => bridge?.close());
      await attempt(() => session?.close());
      await attempt(() => tunnel.stop());
      dependencies.processRef.removeListener("SIGINT", onSigint);
      dependencies.processRef.removeListener("SIGTERM", onSigterm);
      const failure = failures[0];
      if (failure) {
        dependencies.processRef.exitCode = 1;
      }
      try {
        dependencies.writePrivateNewFile(receipt("run-end.json"), JSON.stringify({
          endedAt: new Date().toISOString(), resource: remoteResource,
          cleanup: failure ? "FAILED" : "CLOSED", error: failure ? String(failure) : null,
          advisorResult: "NOT_AUTOMATICALLY_VERIFIED",
        }, null, 2));
        dependencies.writeOutput(JSON.stringify({ event: "c2c_stopped", cleanup: failure ? "FAILED" : "CLOSED" }) + "\n");
      } catch {
        dependencies.processRef.exitCode = 1;
      } finally {
        resolveClosing();
        resolveClosed();
      }
    })();
    return closing;
  };

  dependencies.processRef.once("SIGINT", onSigint);
  dependencies.processRef.once("SIGTERM", onSigterm);

  try {
    await new Promise((resolve, reject) => {
      closedOrigin.once("error", reject);
      closedOrigin.listen(0, "127.0.0.1", resolve);
    });
    if (closing) throw new Error("C2C_CANCELLED");
    deadline = dependencies.setTimer(() => { void stop(); }, Math.max(0, prepared.snapshot.expiresAt - Date.now()));
    const port = closedOrigin.address().port;
    const publicUrl = await tunnel.start(port);
    if (closing) throw new Error("C2C_CANCELLED");
    remoteResource = `${publicUrl}/mcp`;
    const permit = prepareRemoteReview(prepared.snapshot, {
      model: prepared.model,
      resource: remoteResource,
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      reviewedSnapshotDigest: prepared.reviewedSnapshot,
    });
    if (permit.reviewedSnapshotDigest !== prepared.digest) throw new Error("C2C_REMOTE_REVIEWED_SNAPSHOT_MISMATCH");
    const proposedDigest = remoteReviewDigest(permit);
    dependencies.writePrivateNewFile(receipt("remote-permit.json"), JSON.stringify(permit, null, 2));

    terminal = dependencies.createTerminal();
    const input = dependencies.createInput({
      terminal,
      expectedDigest: proposedDigest,
      onStop: stop,
      onApprovalRejected: () => dependencies.writeOutput(JSON.stringify({ event: "c2c_approval_rejected" }) + "\n"),
    });
    dependencies.writeOutput(JSON.stringify({
      event: "c2c_awaiting_scope_approval", resource: remoteResource, model: permit.model,
      permitDigest: proposedDigest, snapshotDigest: prepared.digest, paths: prepared.snapshot.files.map(file => file.path),
      expiresAt: prepared.snapshot.expiresAt, dataClass: prepared.snapshot.dataClass,
    }) + "\n");
    const approvalDigest = await input.approval;
    validateRemoteReview(prepared.snapshot, permit, approvalDigest);
    if (closing) throw new Error("C2C_CANCELLED");

    session = dependencies.createSession(prepared.snapshot, {
      approvalDigest: prepared.digest, stateDir: prepared.stateDir, idleMs: IDLE_MS,
    });
    await closeHttp(closedOrigin);
    bridge = await dependencies.startBridge({
      workspaceRoot: prepared.snapshot.root, review: session, port,
      persistRuntime: false, tunnelProvider: tunnel, authStoreFile: session.authStoreFile,
      remoteReview: { snapshot: prepared.snapshot, permit, approvalDigest }, logger: nullLogger,
    });
    if (closing || bridge.port !== port) {
      await bridge.close();
      throw new Error("C2C_PORT_CHANGED_OR_CANCELLED");
    }
    const pairing = bridge.pairing.create();
    session.onClose(() => { void stop(); });
    dependencies.writeOutput(JSON.stringify({
      event: "c2c_awaiting_chatgpt_connection", resource: remoteResource, pairingCode: pairing.code,
      expiresAt: prepared.snapshot.expiresAt, permitDigest: approvalDigest, auditFile: session.auditFile,
    }) + "\n");
  } catch (error) {
    dependencies.processRef.exitCode = 1;
    dependencies.writeError(String(error) + "\n");
    await stop();
  }
  return Object.freeze({ stop, closed, started: Boolean(bridge) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const runner = await runC2c(parseC2cRunArgs(process.argv.slice(2)));
    await runner.closed;
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(String(error) + "\n");
  }
}
