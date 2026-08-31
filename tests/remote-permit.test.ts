import { afterEach, describe, expect, it } from "vitest";
import { createSnapshot, snapshotDigest } from "../src/review/snapshot.js";
import { prepareRemoteReview, remoteReviewDigest, validateRemoteReview } from "../src/review/remote-permit.js";
import { cleanup, makeGitRepo, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
const target = {
  model: "test-reviewer",
  resource: "https://synthetic-pilot.trycloudflare.com/mcp",
  redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
};
function snapshot(dataClass?: "public" | "synthetic" | "non-sensitive") {
  const root = makeTmpDir("remote-permit");
  dirs.push(root);
  makeGitRepo(root);
  return createSnapshot(root, { taskId: "pilot", paths: ["src/index.ts"], dataClass });
}
afterEach(() => { for (const dir of dirs.splice(0)) cleanup(dir); });

describe("synthetic remote review permit", () => {
  it("binds one destination, model and snapshot without approving or starting any service", () => {
    const s = snapshot("synthetic");
    const p = prepareRemoteReview(s, target);
    expect(Object.isFrozen(p)).toBe(true);
    expect(p).toMatchObject({ ...target, provider: "chatgpt", dataClass: "synthetic" });
    expect(validateRemoteReview(s, p, remoteReviewDigest(p))).toEqual(p);
    expect(() => validateRemoteReview(s, p, "0".repeat(64))).toThrow("REMOTE_APPROVAL_MISMATCH");
  });
  it.each(["public", "non-sensitive"] as const)("rejects %s data without an explicit snapshot attestation", (classification) => {
    expect(() => prepareRemoteReview(snapshot(classification), target)).toThrow("REMOTE_REVIEW_ATTESTATION_REQUIRED");
  });
  it("keeps legacy snapshots local-only", () => {
    expect(() => prepareRemoteReview(snapshot(undefined), target)).toThrow("REMOTE_PILOT_SYNTHETIC_ONLY");
  });
  it("accepts a matching explicit attestation only for real data classes", () => {
    for (const dataClass of ["public", "non-sensitive"] as const) {
      const s = snapshot(dataClass);
      const reviewedSnapshotDigest = snapshotDigest(s);
      const p = prepareRemoteReview(s, { ...target, reviewedSnapshotDigest });
      expect(p).toMatchObject({ ...target, dataClass, reviewedSnapshotDigest, snapshotDigest: reviewedSnapshotDigest });
      expect(Object.keys(p).sort()).toEqual([
        "dataClass", "expiresAt", "model", "provider", "redirectUri", "resource", "reviewedSnapshotDigest", "snapshotDigest", "transport", "version",
      ]);
      expect(validateRemoteReview(s, p, remoteReviewDigest(p))).toEqual(p);
    }
  });
  it("rejects an unsolicited synthetic attestation", () => {
    expect(() => prepareRemoteReview(snapshot("synthetic"), { ...target, reviewedSnapshotDigest: "0".repeat(64) }))
      .toThrow("REMOTE_REVIEW_ATTESTATION_NOT_ALLOWED");
  });
  it("denies changed content, class, destination, and tampered real permits", () => {
    const s = snapshot("non-sensitive");
    const reviewedSnapshotDigest = snapshotDigest(s);
    const p = prepareRemoteReview(s, { ...target, reviewedSnapshotDigest });

    const changed = structuredClone(s);
    changed.files[0].after = "export const changed = true;\n";
    expect(() => validateRemoteReview(changed, p, remoteReviewDigest(p))).toThrow();

    const changedClass = { ...s, dataClass: "public" as const };
    expect(() => validateRemoteReview(changedClass, p, remoteReviewDigest(p))).toThrow();

    const other = prepareRemoteReview(s, {
      ...target,
      resource: "https://different.trycloudflare.com/mcp",
      reviewedSnapshotDigest,
    });
    expect(() => validateRemoteReview(s, other, remoteReviewDigest(p))).toThrow("REMOTE_APPROVAL_MISMATCH");

    expect(() => validateRemoteReview(s, { ...p, reviewedSnapshotDigest: "0".repeat(64) }, remoteReviewDigest(p)))
      .toThrow();
    expect(() => validateRemoteReview(s, { ...p, extra: true } as typeof p, remoteReviewDigest(p)))
      .toThrow("REMOTE_PERMIT_MISMATCH");
  });
  it("does not let a previous approval authorize changed content or a different destination", () => {
    const s = snapshot("synthetic");
    const p = prepareRemoteReview(s, target);
    const changed = structuredClone(s);
    changed.files[0].after = "export const changed = true;\n";
    expect(() => validateRemoteReview(changed, p, remoteReviewDigest(p))).toThrow("REMOTE_PERMIT_MISMATCH");
    for (const patch of [
      { model: "other-reviewer" },
      { resource: "https://different.trycloudflare.com/mcp" },
      { redirectUri: "https://chatgpt.com/another_callback" },
    ]) {
      const other = prepareRemoteReview(s, { ...target, ...patch });
      expect(() => validateRemoteReview(s, other, remoteReviewDigest(p))).toThrow("REMOTE_APPROVAL_MISMATCH");
    }
  });
  it("rejects expired proposals and extra or altered permit fields", () => {
    const s = snapshot("synthetic");
    const p = prepareRemoteReview(s, target);
    expect(() => prepareRemoteReview(s, target, s.expiresAt)).toThrow("SNAPSHOT_EXPIRED");
    expect(() => validateRemoteReview(s, { ...p, expiresAt: p.expiresAt + 1 }, remoteReviewDigest(p))).toThrow("REMOTE_PERMIT_MISMATCH");
    expect(() => validateRemoteReview(s, { ...p, extra: true } as typeof p, remoteReviewDigest(p))).toThrow("REMOTE_PERMIT_MISMATCH");
  });
  it("rejects unsafe or unintended destination forms", () => {
    const s = snapshot("synthetic");
    for (const resource of [
      "http://synthetic-pilot.trycloudflare.com/mcp",
      "https://synthetic-pilot.trycloudflare.com.evil.example/mcp",
      "https://synthetic-pilot.trycloudflare.com/admin/info",
      "https://synthetic-pilot.trycloudflare.com/mcp?x=1",
      "https://user@synthetic-pilot.trycloudflare.com/mcp",
      "https://127.0.0.1/mcp",
    ]) expect(() => prepareRemoteReview(s, { ...target, resource })).toThrow();
    for (const redirectUri of [
      "https://chatgpt.com.evil.example/callback",
      "https://chatgpt.com/*",
      "https://chatgpt.com/callback#fragment",
      "http://127.0.0.1/callback",
    ]) expect(() => prepareRemoteReview(s, { ...target, redirectUri })).toThrow();
  });
});
