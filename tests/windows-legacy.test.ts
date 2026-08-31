import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace, WorkspaceError } from "../src/workspace/manager.js";
import { canCreateFileSymlink, makeTmpDir, cleanup, write } from "./helpers.js";
import { validateNativeEvidence } from "./g7-native-evidence-helper.js";

let root: string;
let outside: string;
let ws: Workspace;
const fileSymlinkSupported = canCreateFileSymlink();
const evidenceFile = process.env.C2C_G7_NATIVE_EVIDENCE;
const evidenceNonce = process.env.C2C_G7_NATIVE_NONCE;
let fixtureEvidence: ReturnType<typeof validateNativeEvidence> | undefined;

beforeAll(() => {
  if (evidenceFile) {
    if (!evidenceNonce) throw new Error("G7_NATIVE_EVIDENCE_NONCE_MISSING");
    fixtureEvidence = validateNativeEvidence(JSON.parse(fs.readFileSync(evidenceFile, "utf8")), evidenceNonce);
    root = path.dirname(fixtureEvidence.artifacts.legacySymlink.path);
    outside = path.join(fixtureEvidence.root, "outside");
    ws = new Workspace(root);
    return;
  }
  root = makeTmpDir("legacy-ws");
  outside = makeTmpDir("legacy-outside");
  write(outside, "secret.txt", "outside data\n");
  ws = new Workspace(root);
});

afterAll(() => {
  if (!fixtureEvidence) { cleanup(root); cleanup(outside); }
});

describe("legacy link safety", () => {
  if (fileSymlinkSupported && !evidenceFile) {
    it("rejects a file symlink escaping the workspace", () => {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-out.txt"));
      try {
        ws.resolve("link-out.txt");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
      }
    });
  } else if (evidenceFile) {
    it("uses the elevated helper's actual file symlink when direct creation is unavailable", () => {
      const link = fixtureEvidence!.artifacts.legacySymlink.path;
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      try {
        ws.resolve(path.basename(link));
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
      }
    });
  } else {
    it.skip("CANNOT_VERIFY: file symlink escape proof (symbolic links unavailable)", () => {});
  }

  it("resolves an actual hardlink by its in-workspace directory entry", () => {
    const hardlink = path.join(root, "hardlink-in.txt");
    const target = fixtureEvidence
      ? fs.realpathSync.native(fixtureEvidence.artifacts.legacySymlink.path)
      : path.join(outside, "secret.txt");
    fs.linkSync(target, hardlink);
    expect(ws.resolve("hardlink-in.txt").rel).toBe("hardlink-in.txt");
  });
});
