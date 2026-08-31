import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { createSnapshot, parseSnapshot, snapshotDigest, REVIEW_PROTOCOL_LIMITS, type ReviewSnapshot } from "../review/snapshot.js";
import { prepareRemoteReview, remoteReviewDigest, validateRemoteReview, type RemoteReviewPermit } from "../review/remote-permit.js";
import { ReviewSession } from "../review/session.js";
import { startBridge } from "../bridge/server.js";
import { nullLogger } from "../logger/index.js";
import { writePrivateNewFile } from "../review/private-storage.js";

const MAX_REMOTE_PERMIT_BYTES = 64 * 1024;

function readSnapshot(file: string): ReviewSnapshot {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error("INVALID_SNAPSHOT_FILE");
  return parseSnapshot(JSON.parse(fs.readFileSync(file, "utf8")));
}

function readRemotePermit(file: string): RemoteReviewPermit {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_REMOTE_PERMIT_BYTES) throw new Error("INVALID_REMOTE_PERMIT_FILE");
  return JSON.parse(fs.readFileSync(file, "utf8")) as RemoteReviewPermit;
}

function assertOutputOutsideReviewRoot(root: string, output: string): void {
  const relative = path.relative(root, output);
  if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("SNAPSHOT_OUTPUT_INSIDE_REVIEW_ROOT");
}

function parseLoopbackPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("INVALID_PORT");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("INVALID_PORT");
  return port;
}

export function registerReviewCommands(program: Command): void {
  const review = program.command("review").description("Approved, single-use snapshot review");
  review.command("run").description("Run one explicitly approved real-repository C2C review")
    .requiredOption("--snapshot <file>", "prepared, inspected public or non-sensitive snapshot")
    .requiredOption("--model <model>")
    .requiredOption("--state-dir <path>", "dedicated state outside the reviewed repository")
    .requiredOption("--authorize-external-review", "operator attestation of actual scoped user consent")
    .requiredOption("--reviewed-snapshot <sha256>", "exact snapshot digest reviewed for non-sensitive content")
    .action(async (opts: { snapshot: string; model: string; stateDir: string; reviewedSnapshot: string }) => {
      const runnerUrl = new URL("../../scripts/run-c2c.mjs", import.meta.url);
      const { parseC2cRunArgs, runC2c } = await import(runnerUrl.href);
      await runC2c(parseC2cRunArgs([
        "--snapshot", opts.snapshot, "--model", opts.model, "--state-dir", opts.stateDir,
        "--authorize-external-review", "--reviewed-snapshot", opts.reviewedSnapshot,
      ]));
    });

  review.command("prepare")
    .requiredOption("--workspace <path>")
    .requiredOption("--task <id>")
    .requiredOption("--files <paths...>", "exact repository-relative file paths")
    .requiredOption("--data-class <class>", "public, non-sensitive, or synthetic")
    .option("--base <commit>", "optional pinned base commit OID")
    .requiredOption("--output <file>", "new local snapshot file outside the reviewed repository")
    .action((opts: { workspace: string; task: string; files: string[]; dataClass: string; base?: string; output: string }) => {
      if (opts.dataClass !== "public" && opts.dataClass !== "synthetic" && opts.dataClass !== "non-sensitive") throw new Error("DATA_CLASS_NOT_ALLOWED");
      const snapshot = createSnapshot(opts.workspace, {
        taskId: opts.task,
        paths: opts.files,
        dataClass: opts.dataClass,
        ...(opts.base === undefined ? {} : { baseCommit: opts.base }),
      });
      const output = path.resolve(opts.output);
      assertOutputOutsideReviewRoot(snapshot.root, output);
      // Never overwrite a previous proposal. Snapshot content is not an audit log.
      writePrivateNewFile(output, JSON.stringify(snapshot, null, 2));
      process.stdout.write(JSON.stringify({ snapshot: output, digest: snapshotDigest(snapshot), dataClass: snapshot.dataClass, files: snapshot.files.map((file) => file.path), expiresAt: snapshot.expiresAt, protocolLimits: REVIEW_PROTOCOL_LIMITS, approved: false }) + "\n");
    });

  review.command("inspect").requiredOption("--snapshot <file>")
    .action((opts: { snapshot: string }) => {
      const snapshot = readSnapshot(opts.snapshot);
      process.stdout.write(JSON.stringify({ digest: snapshotDigest(snapshot), snapshot, protocolLimits: REVIEW_PROTOCOL_LIMITS }, null, 2) + "\n");
    });

  review.command("remote-plan")
    .requiredOption("--snapshot <file>")
    .requiredOption("--model <model>")
    .requiredOption("--resource <url>")
    .requiredOption("--redirect-uri <url>")
    .option("--reviewed-snapshot <sha256>", "explicit attestation for public or non-sensitive snapshot bytes")
    .requiredOption("--output <file>", "new local permit file outside the reviewed repository")
    .action((opts: { snapshot: string; model: string; resource: string; redirectUri: string; reviewedSnapshot?: string; output: string }) => {
      const snapshot = readSnapshot(opts.snapshot);
      const permit = prepareRemoteReview(snapshot, {
        model: opts.model,
        resource: opts.resource,
        redirectUri: opts.redirectUri,
        ...(opts.reviewedSnapshot === undefined ? {} : { reviewedSnapshotDigest: opts.reviewedSnapshot }),
      });
      const output = path.resolve(opts.output);
      assertOutputOutsideReviewRoot(snapshot.root, output);
      // A permit is a review proposal, never an approval receipt. Do not overwrite it.
      writePrivateNewFile(output, JSON.stringify(permit, null, 2));
      process.stdout.write(JSON.stringify({
        permit: output,
        digest: remoteReviewDigest(permit),
        target: { model: permit.model, resource: permit.resource, redirectUri: permit.redirectUri },
        approved: false,
      }) + "\n");
    });

  review.command("serve")
    .requiredOption("--snapshot <file>")
    .requiredOption("--approval <sha256>", "digest explicitly approved for this single local mock review")
    .requiredOption("--state-dir <path>", "dedicated state directory outside the reviewed repository")
    .action(async (opts: { snapshot: string; approval: string; stateDir: string }) => {
      const snapshot = readSnapshot(opts.snapshot);
      const session = new ReviewSession(snapshot, { approvalDigest: opts.approval, stateDir: opts.stateDir });
      try {
        const bridge = await startBridge({
          workspaceRoot: snapshot.root, review: session, port: 0, persistRuntime: false,
          authStoreFile: session.authStoreFile, logger: nullLogger,
        });
        const pairing = bridge.pairing.create();
        process.stdout.write(JSON.stringify({ mode: "LOCAL_MOCK_ONLY", url: `${bridge.localBaseUrl()}/mcp`, digest: session.digest, pairingCode: pairing.code, expiresAt: session.expiresAt }) + "\n");
        const shutdown = (): void => { void bridge.close().catch(() => { process.exitCode = 1; }); };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      } catch (error) {
        session.close();
        throw error;
      }
    });

  review.command("serve-remote")
    .requiredOption("--snapshot <file>")
    .requiredOption("--permit <file>")
    .requiredOption("--approval <sha256>", "digest explicitly approved for this remote review")
    .requiredOption("--state-dir <path>", "dedicated state directory outside the reviewed repository")
    .option("--port <port>", "preferred loopback port for an externally owned tunnel wrapper")
    .action(async (opts: { snapshot: string; permit: string; approval: string; stateDir: string; port?: string }) => {
      const snapshot = readSnapshot(opts.snapshot);
      const permit = readRemotePermit(opts.permit);
      const approvedPermit = validateRemoteReview(snapshot, permit, opts.approval);
      const port = parseLoopbackPort(opts.port);
      const snapshotApproval = snapshotDigest(snapshot);
      const session = new ReviewSession(snapshot, { approvalDigest: snapshotApproval, stateDir: opts.stateDir });
      try {
        const bridge = await startBridge({
          workspaceRoot: snapshot.root,
          review: session,
          remoteReview: { snapshot, permit: approvedPermit, approvalDigest: opts.approval },
          port,
          host: "127.0.0.1",
          persistRuntime: false,
          authStoreFile: session.authStoreFile,
          logger: nullLogger,
        });
        const pairing = bridge.pairing.create();
        process.stdout.write(JSON.stringify({
          mode: approvedPermit.dataClass === "synthetic" ? "SYNTHETIC_REMOTE_PILOT" : "BOUNDED_REMOTE_REVIEW",
          url: `${bridge.localBaseUrl()}/mcp`,
          resource: approvedPermit.resource,
          digest: remoteReviewDigest(approvedPermit),
          pairingCode: pairing.code,
          expiresAt: approvedPermit.expiresAt,
        }) + "\n");
        const shutdown = (): void => { void bridge.close().catch(() => { process.exitCode = 1; }); };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      } catch (error) {
        session.close();
        throw error;
      }
    });
}
