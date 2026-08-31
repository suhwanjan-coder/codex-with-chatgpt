import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ReviewSession } from "../review/session.js";
import { remoteReviewDigest, validateRemoteReview, type RemoteReviewPermit } from "../review/remote-permit.js";
import { snapshotDigest, type ReviewSnapshot } from "../review/snapshot.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";
import { verifyPrivateFile, writePrivateNewFile } from "../review/private-storage.js";

export interface BridgeOptions {
  workspaceRoot: string;
  review?: ReviewSession;
  /** Explicit, permit-bound remote review policy. It never starts a tunnel. */
  remoteReview?: {
    snapshot: ReviewSnapshot;
    permit: RemoteReviewPermit;
    approvalDigest: string;
  };
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
}

export interface Bridge {
  workspace: Workspace;
  port: number;
  host: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

/**
 * Listen on the preferred port; on EADDRINUSE fall back to an ephemeral port.
 */
function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  const workspace = new Workspace(opts.workspaceRoot);
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1") {
    throw new Error("The isolated review bridge only binds to IPv4 loopback (127.0.0.1).");
  }
  if (opts.review && (opts.review.root !== workspace.root || !opts.review.isActive())) throw new Error("REVIEW_WORKSPACE_MISMATCH");
  let remotePermit: RemoteReviewPermit | undefined;
  let remotePermitDigest: string | undefined;
  let remotePublicOrigin: string | undefined;
  let remotePublicHost: string | undefined;
  if (opts.remoteReview) {
    if (!opts.review) throw new Error("REMOTE_REVIEW_SESSION_REQUIRED");
    remotePermit = validateRemoteReview(opts.remoteReview.snapshot, opts.remoteReview.permit, opts.remoteReview.approvalDigest);
    if (snapshotDigest(opts.remoteReview.snapshot) !== opts.review.digest) throw new Error("REMOTE_REVIEW_SNAPSHOT_MISMATCH");
    const destination = new URL(remotePermit.resource);
    remotePublicOrigin = destination.origin;
    remotePublicHost = destination.host;
    remotePermitDigest = remoteReviewDigest(remotePermit);
    opts.review.recordRemoteReview({
      resource: remotePermit.resource,
      redirectUri: remotePermit.redirectUri,
      model: remotePermit.model,
      permitDigest: remotePermitDigest,
    });
  }
  const authId = `${workspace.id}_${opts.review?.digest ?? "closed"}_${randomBytes(12).toString("hex")}`;
  let authStoreFile = opts.authStoreFile;
  if (opts.review) {
    const required = opts.review.authStoreFile;
    if (authStoreFile !== undefined && path.resolve(authStoreFile) !== path.resolve(required)) throw new Error("REVIEW_AUTH_STORE_PATH");
    try {
      writePrivateNewFile(required, JSON.stringify({ clients: [], tokens: [] }));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "PRIVATE_STORAGE_EXISTS") throw new Error("REVIEW_AUTH_STORE_UNAVAILABLE");
      try { verifyPrivateFile(required); } catch { throw new Error("REVIEW_AUTH_STORE_UNAVAILABLE"); }
    }
    authStoreFile = required;
  }
  const authStore = new AuthStore(authId, { file: authStoreFile });
  // Old grants must be revoked before a listener exists, including after a crash.
  authStore.revokeAll();
  const pairing = new PairingManager(authId, { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? new CloudflaredQuickTunnel(logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;

  let publicBaseUrl: string | null = null;

  const app = express();
  app.set("trust proxy", false);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    return remotePublicOrigin ?? `http://127.0.0.1:${port}`;
  };

  const oauthReview = remotePermit && remotePublicOrigin
    ? {
        isActive: () => opts.review!.isActive(),
        expiresAt: opts.review!.expiresAt,
        remote: {
          issuer: `${remotePublicOrigin}/`,
          resource: remotePermit.resource,
          allowedRedirectUris: [remotePermit.redirectUri],
        },
      }
    : opts.review;

  let closed = false;
  app.use((req, res, next) => {
    const origin = req.get("origin");
    const localBaseUrl = `http://127.0.0.1:${port}`;
    const localHost = `127.0.0.1:${port}`;
    if (!remotePublicHost) {
      if (closed || req.get("host") !== localHost ||
          (origin !== undefined && origin !== localBaseUrl) ||
          Object.keys(req.headers).some((key) => key.startsWith("x-forwarded-") || key.startsWith("cf-") || key === "forwarded")) {
        res.status(403).json({ error: "LOCAL_REVIEW_ONLY" });
        return;
      }
      next();
      return;
    }
    const requestHost = req.get("host");
    const isPublicRequest = requestHost === remotePublicHost;
    const isLocalhostRequest = requestHost === `localhost:${port}`;
    const isLocalRequest = requestHost === localHost || isLocalhostRequest;
    const expectedOrigin = isPublicRequest ? remotePublicOrigin : isLocalhostRequest ? `http://localhost:${port}` : localBaseUrl;
    if (closed || (!isPublicRequest && !isLocalRequest) || (origin !== undefined && origin !== expectedOrigin)) {
      res.status(403).json({ error: "REMOTE_REVIEW_ONLY" });
      return;
    }
    if (isPublicRequest && (req.path === "/health" || req.path === "/admin" || req.path.startsWith("/admin/"))) {
      res.status(404).end();
      return;
    }
    next();
  });

  // ---- Health (public but minimal) ---------------------------------------

  const remoteHealthGuard = (_req: Request, res: Response, next: NextFunction): void => {
    if (remotePermit) {
      res.status(404).end();
      return;
    }
    next();
  };

  app.get("/health", remoteHealthGuard, (_req, res) => {
    res.json({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" });
  });

  // ---- OAuth + discovery ---------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: "Local isolated review",
      getBaseUrl,
      logger,
      review: oauthReview,
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  const mcpHandler = createMcpHttpHandler(
    () => createMcpServer({ workspace, logger, review: opts.review, readOnly: Boolean(remotePermit) }),
    logger,
    opts.review,
    { readOnly: Boolean(remotePermit) }
  );
  app.all(
    "/mcp",
    express.json({ limit: "16kb" }),
    bearerAuth({ store: authStore, workspaceId: authId, getBaseUrl, logger }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  // ---- Admin API (loopback + admin token only; used by the CLI/Skill) --------

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    if (remotePermit) {
      res.status(404).end();
      return;
    }
    // Defense in depth: reject anything that arrived through a proxy/tunnel.
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    if (opts.review && !opts.review.isActive()) { res.status(403).json({ error: "SESSION_CLOSED" }); return; }
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceName: "Local isolated review",
      workspaceRoot: workspace.root,
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    res.status(403).json({ error: "PUBLIC_TUNNEL_DISABLED" });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500;
    if (res.headersSent) { res.destroy(); return; }
    res.status(status === 413 ? 413 : status >= 400 && status < 500 ? 400 : 500).json({ error: "REQUEST_REJECTED" });
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  const startedAt = new Date().toISOString();
  logger.info(`Bridge listening on ${host}:${port} for workspace ${workspace.name} (${workspace.id})`);

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
    };
    writeRuntimeState(state);
  };
  persistRuntime();

  let shutdownPromise: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    if (idleTimer) clearInterval(idleTimer);
    pairing.invalidateAll();
    shutdownPromise = (async () => {
      let revokeError: unknown;
      let tunnelError: unknown;
      try { authStore.revokeAll(); } catch (error) { revokeError = error; }
      opts.review?.close();
      try { await tunnel.stop(); } catch (error) { tunnelError = error; }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        const force = setTimeout(() => server.closeAllConnections(), 500);
        force.unref();
      });
      if (opts.persistRuntime !== false) clearRuntimeState(workspace.id);
      logger.info("Bridge stopped");
      if (revokeError) throw new Error("TOKEN_REVOCATION_FAILED");
      if (tunnelError) throw new Error("TUNNEL_STOP_FAILED");
    })();
    return shutdownPromise;
  };

  if (opts.review) {
    opts.review.onClose(() => { setTimeout(() => { void shutdown().catch(() => logger.error("Review cleanup failed")); }, 25); });
    idleTimer = setInterval(() => { opts.review?.isActive(); }, 100);
    idleTimer.unref();
  }

  return {
    workspace,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    tunnel,
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
