import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSnapshot } from "../src/review/snapshot.js";
import { cleanup, makeGitRepo, makeTmpDir, write } from "./helpers.js";
import { G7_NATIVE_IDS, validateNativeEvidence } from "./g7-native-evidence-helper.js";

const tempDirs: string[] = [];
const nativeEvidenceFile = process.env.C2C_G7_NATIVE_EVIDENCE;
const nativeEvidenceNonce = process.env.C2C_G7_NATIVE_NONCE;

function repo(name: string): string {
  const dir = makeTmpDir(name);
  tempDirs.push(dir);
  makeGitRepo(dir);
  return dir;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function expectCode(fn: () => unknown, code: string): void {
  expect(fn).toThrowError(new Error(code));
}

function expectFailClosed(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/^SNAPSHOT_[A-Z_]+$/);
}

function isAdsUnavailable(error: unknown): boolean {
  return ["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error) ?? "");
}

function isLongPathUnavailable(error: unknown): boolean {
  return ["EINVAL", "ENAMETOOLONG", "ENOENT"].includes(errorCode(error) ?? "");
}

function longPathFixture(root: string): { relative: string; absolute: string } {
  const parts: string[] = [];
  let relative = "safe.txt";
  let absolute = path.join(root, relative);
  while (relative.length <= 260 || absolute.length <= 260) {
    if (parts.length >= 32) throw new Error("LONG_PATH_FIXTURE_TOO_LONG");
    parts.push(`native-long-path-${String(parts.length).padStart(2, "0")}-${"x".repeat(40)}`);
    relative = [...parts, "safe.txt"].join("/");
    absolute = path.join(root, ...parts, "safe.txt");
  }
  return { relative, absolute };
}

type ShortPathResult =
  | { status: "available"; value: string }
  | { status: "unavailable"; reason: string };

function getFsoShortPath(inputPath: string): ShortPathResult {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; $fso = New-Object -ComObject Scripting.FileSystemObject; [Console]::Out.Write($fso.GetFile($env:C2C_REVIEW_SHORT_PATH).ShortPath)",
    ],
    {
      env: { ...process.env, C2C_REVIEW_SHORT_PATH: inputPath },
      encoding: "utf8",
      maxBuffer: 8 * 1024,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (result.error) {
    if (errorCode(result.error) === "ENOENT") {
      return { status: "unavailable", reason: "CANNOT_VERIFY: powershell.exe unavailable for FSO short path" };
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    throw new Error(`FSO_SHORT_PATH:${stderr || "powershell failed"}`);
  }
  const value = String(result.stdout ?? "").trim();
  if (value === "") {
    return { status: "unavailable", reason: "CANNOT_VERIFY: FSO returned no short path" };
  }
  return { status: "available", value };
}

afterEach(() => {
  while (tempDirs.length > 0) cleanup(tempDirs.pop()!);
});

if (!nativeEvidenceFile) describe.skipIf(process.platform !== "win32")("native Windows review snapshot safety", () => {
  it("[G7:NATIVE_ADS] rejects a colon path after real ADS content is confirmed", ({ skip }) => {
    const root = repo("g7-native-ads");
    const adsPath = `${path.join(root, "hello.txt")}:codex-native-ads`;
    const content = "confirmed ADS fixture\n";
    try {
      fs.writeFileSync(adsPath, content, "utf8");
      expect(fs.existsSync(adsPath)).toBe(true);
      expect(fs.readFileSync(adsPath, "utf8")).toBe(content);
      expect(fs.statSync(adsPath).isFile()).toBe(true);
    } catch (error) {
      if (isAdsUnavailable(error)) {
        skip(`CANNOT_VERIFY: alternate data streams unavailable (${errorCode(error)})`);
        return;
      }
      throw error;
    }

    expectCode(
      () => createSnapshot(root, { taskId: "g7-native-ads", paths: ["hello.txt:codex-native-ads"] }),
      "SNAPSHOT_PATH",
    );
  });

  it("[G7:ANCESTOR_JUNCTION] rejects a nested junction ancestor", () => {
    const root = repo("g7-ancestor-junction");
    const outside = makeTmpDir("g7-ancestor-junction-outside");
    tempDirs.push(outside);
    const content = "outside junction fixture\n";
    const outsideFile = write(outside, "payload.txt", content);
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    const junction = path.join(nested, "redirect");
    fs.symlinkSync(outside, junction, "junction");

    expect(fs.lstatSync(junction).isSymbolicLink()).toBe(true);
    expect(fs.statSync(junction).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(junction, "payload.txt"), "utf8")).toBe(content);
    expect(fs.realpathSync.native(junction).toLowerCase()).toBe(fs.realpathSync.native(outside).toLowerCase());
    expect(fs.statSync(path.join(junction, "payload.txt")).ino).toBe(fs.statSync(outsideFile).ino);

    expectCode(
      () => createSnapshot(root, { taskId: "g7-ancestor-junction", paths: ["nested/redirect/payload.txt"] }),
      "SNAPSHOT_ALIAS",
    );
  });

  it("[G7:FILE_SYMLINK] rejects an actual file symlink to an outside file", ({ skip }) => {
    const root = repo("g7-file-symlink");
    const outside = makeTmpDir("g7-file-symlink-outside");
    tempDirs.push(outside);
    const outsideFile = write(outside, "outside.txt", "outside symlink fixture\n");
    const link = path.join(root, "outside-link.txt");
    try {
      fs.symlinkSync(outsideFile, link, "file");
    } catch (error) {
      if (errorCode(error) === "EPERM") {
        skip("CANNOT_VERIFY: file symlink creation denied with EPERM");
        return;
      }
      throw error;
    }

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.statSync(link).isFile()).toBe(true);
    expect(fs.readFileSync(link, "utf8")).toBe("outside symlink fixture\n");
    expect(fs.realpathSync.native(link).toLowerCase()).toBe(fs.realpathSync.native(outsideFile).toLowerCase());

    expectCode(() => createSnapshot(root, { taskId: "g7-file-symlink", paths: ["outside-link.txt"] }), "SNAPSHOT_ALIAS");
  });

  it("[G7:LONG_PATH] captures safe content or fails closed for an actual path over 260 characters", ({ skip }) => {
    const root = repo("g7-long-path");
    const fixture = longPathFixture(root);
    const content = "safe long path fixture\n";
    try {
      fs.mkdirSync(path.dirname(fixture.absolute), { recursive: true });
      fs.writeFileSync(fixture.absolute, content, "utf8");
      expect(fixture.absolute.length).toBeGreaterThan(260);
      expect(fixture.relative.length).toBeGreaterThan(260);
      expect(fs.statSync(fixture.absolute).isFile()).toBe(true);
      expect(fs.readFileSync(fixture.absolute, "utf8")).toBe(content);
    } catch (error) {
      if (isLongPathUnavailable(error)) {
        skip(`CANNOT_VERIFY: actual >260 path fixture unavailable (${errorCode(error)})`);
        return;
      }
      throw error;
    }

    try {
      const snapshot = createSnapshot(root, { taskId: "g7-long-path", paths: [fixture.relative] });
      expect(snapshot.files).toEqual([{ path: fixture.relative, before: null, after: content }]);
    } catch (error) {
      expectFailClosed(error);
    }
  });

  it("[G7:SHORT_ALIAS] rejects a real differing FSO short-path alias", ({ skip }) => {
    const root = repo("g7-short-alias");
    const content = "safe short alias fixture\n";
    const longName = `native-short-alias-fixture-${"x".repeat(56)}.txt`;
    const fixture = write(root, longName, content);
    expect(fs.readFileSync(fixture, "utf8")).toBe(content);
    expect(fs.statSync(fixture).isFile()).toBe(true);

    const shortPath = getFsoShortPath(fixture);
    if (shortPath.status === "unavailable") {
      skip(shortPath.reason);
      return;
    }
    const normalizedShortPath = path.win32.normalize(shortPath.value);
    const normalizedLongPath = path.win32.normalize(fixture);
    expect(path.win32.isAbsolute(normalizedShortPath)).toBe(true);
    const shortName = path.win32.basename(normalizedShortPath);
    const actualLongName = path.win32.basename(normalizedLongPath);
    if (shortName.toLowerCase() === actualLongName.toLowerCase()) {
      skip("CANNOT_VERIFY: filesystem returned no differing 8.3 alias for the real long-named fixture");
      return;
    }
    expect(shortName).not.toMatch(/[\\/:]/);

    const alias = path.join(root, shortName);
    expect(fs.existsSync(alias)).toBe(true);
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(false);
    expect(fs.statSync(alias).isFile()).toBe(true);
    expect(fs.statSync(alias).ino).toBe(fs.statSync(fixture).ino);
    expect(fs.readFileSync(alias, "utf8")).toBe(content);

    expectCode(() => createSnapshot(root, { taskId: "g7-short-alias", paths: [shortName] }), "SNAPSHOT_ALIAS");
  });
});
else describe.skipIf(process.platform !== "win32")("fresh elevated Windows G7 evidence", () => {
  function evidence() {
    if (!nativeEvidenceNonce) throw new Error("G7_NATIVE_EVIDENCE_NONCE_MISSING");
    return validateNativeEvidence(JSON.parse(fs.readFileSync(nativeEvidenceFile, "utf8")), nativeEvidenceNonce);
  }

  it.each(G7_NATIVE_IDS)("[G7:%s] validates fresh bounded native evidence", (id) => {
    const value = evidence();
    const native = (value as typeof value & { native: {
      adsPath: string; adsSha256: string; longPath: { absolute: string; relative: string }; longPathOutcome: string;
      shortSource: string; shortAlias: { path: string; relative: string }; junction: { path: string; linkType: string };
    } }).native;
    expect(value.helper.success).toBe(true);
    if (id === "NATIVE_ADS") expect(fs.readFileSync(native.adsPath, "utf8")).toBe("synthetic ADS content\n");
    if (id === "ANCESTOR_JUNCTION") {
      expect(native.junction.linkType).toBe("Junction");
      expect(fs.lstatSync(native.junction.path).isSymbolicLink()).toBe(true);
      expect(value.snapshotRejections.ancestorJunction).toMatch(/^SNAPSHOT_/);
    }
    if (id === "FILE_SYMLINK") {
      expect(fs.lstatSync(value.artifacts.fileSymlink.path).isSymbolicLink()).toBe(true);
      expect(value.snapshotRejections.fileSymlink).toMatch(/^SNAPSHOT_/);
    }
    if (id === "LONG_PATH") {
      expect(native.longPath.absolute.length).toBeGreaterThan(260);
      expect(["captured", ...Object.values(value.snapshotRejections)]).toContain(native.longPathOutcome);
    }
    if (id === "SHORT_ALIAS") {
      expect(native.shortAlias.relative).not.toBe(path.basename(native.shortSource));
      expect(value.snapshotRejections.shortAlias).toMatch(/^SNAPSHOT_/);
    }
    if (id === "OTHER_REPARSE") {
      expect(value.helper.reparse.tag).toBe(0x80000024);
      expect(value.helper.reparse.isSymbolicLink).toBe(false);
      expect(value.helper.reparse.isJunction).toBe(false);
      // evidence() already independently verifies the native tag; Node lstat rejects LX_FIFO.
      expect(value.snapshotRejections.otherReparse).toMatch(/^SNAPSHOT_/);
    }
    if (id === "ACL_ISOLATION") {
      expect(value.helper.acl.controls.usersReadWrite).toBe(true);
      expect(value.helper.acl.controls.everyoneReadWrite).toBe(true);
      expect(Object.values(value.helper.acl.denied)).toHaveLength(5);
      expect(value.helper.cleanup.userNotFound).toBe(true);
    }
  });
});
