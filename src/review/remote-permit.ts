import { createHash, timingSafeEqual } from "node:crypto";
import { parseSnapshot, snapshotDigest, type ReviewDataClass } from "./snapshot.js";

export interface RemoteReviewTarget {
  model: string;
  resource: string;
  redirectUri: string;
  reviewedSnapshotDigest?: string;
}

export interface RemoteReviewPermit extends RemoteReviewTarget {
  version: 1;
  provider: "chatgpt";
  transport: "cloudflare-quick";
  dataClass: ReviewDataClass;
  snapshotDigest: string;
  expiresAt: number;
  reviewedSnapshotDigest?: string;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function canonicalUrl(value: string): URL {
  if (typeof value !== "string") throw new Error("INVALID_REMOTE_DESTINATION");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("INVALID_REMOTE_DESTINATION"); }
  if (url.href !== value || url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("INVALID_REMOTE_DESTINATION");
  }
  return url;
}

/** A proposal is not consent. The caller must obtain approval of its digest. */
export function prepareRemoteReview(input: unknown, target: RemoteReviewTarget, now = Date.now()): RemoteReviewPermit {
  const snapshot = parseSnapshot(input);
  const dataClass = snapshot.dataClass;
  if (dataClass === undefined) throw new Error("REMOTE_PILOT_SYNTHETIC_ONLY");
  if (now < snapshot.createdAt || now >= snapshot.expiresAt) throw new Error("SNAPSHOT_EXPIRED");
  if (typeof target.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.model)) {
    throw new Error("INVALID_REMOTE_MODEL");
  }
  const resource = canonicalUrl(target.resource);
  const redirect = canonicalUrl(target.redirectUri);
  if (!/^[a-z0-9][a-z0-9-]*\.trycloudflare\.com$/.test(resource.hostname) || resource.pathname !== "/mcp") {
    throw new Error("INVALID_REMOTE_RESOURCE");
  }
  if (redirect.hostname !== "chatgpt.com" || redirect.pathname === "/" || target.redirectUri.includes("*")) {
    throw new Error("INVALID_REMOTE_REDIRECT");
  }
  const snapshotHash = snapshotDigest(snapshot);
  let reviewedSnapshotDigest: string | undefined;
  if (dataClass === "synthetic") {
    if (target.reviewedSnapshotDigest !== undefined) throw new Error("REMOTE_REVIEW_ATTESTATION_NOT_ALLOWED");
  } else {
    if (!isSha256(target.reviewedSnapshotDigest)) throw new Error("REMOTE_REVIEW_ATTESTATION_REQUIRED");
    if (target.reviewedSnapshotDigest !== snapshotHash) throw new Error("REMOTE_REVIEW_ATTESTATION_MISMATCH");
    reviewedSnapshotDigest = target.reviewedSnapshotDigest;
  }
  return Object.freeze({
    version: 1, provider: "chatgpt", transport: "cloudflare-quick", dataClass,
    model: target.model, resource: resource.href, redirectUri: redirect.href,
    snapshotDigest: snapshotHash,
    ...(reviewedSnapshotDigest === undefined ? {} : { reviewedSnapshotDigest }),
    expiresAt: snapshot.expiresAt,
  });
}

export function remoteReviewDigest(permit: RemoteReviewPermit): string {
  return createHash("sha256").update(JSON.stringify(permit)).digest("hex");
}

export function validateRemoteReview(input: unknown, permit: RemoteReviewPermit, approvedDigest: string, now = Date.now()): RemoteReviewPermit {
  if (!permit || typeof permit !== "object" || Array.isArray(permit)) throw new Error("INVALID_REMOTE_PERMIT");
  const expected = prepareRemoteReview(input, permit, now);
  const keys = Object.keys(expected).sort();
  const supplied = Object.keys(permit).sort();
  if (keys.length !== supplied.length || keys.some((key, i) => key !== supplied[i]) ||
      keys.some(key => permit[key as keyof RemoteReviewPermit] !== expected[key as keyof RemoteReviewPermit])) {
    throw new Error("REMOTE_PERMIT_MISMATCH");
  }
  if (typeof approvedDigest !== "string" || !/^[a-f0-9]{64}$/.test(approvedDigest) ||
      !timingSafeEqual(Buffer.from(remoteReviewDigest(expected)), Buffer.from(approvedDigest))) {
    throw new Error("REMOTE_APPROVAL_MISMATCH");
  }
  return expected;
}
