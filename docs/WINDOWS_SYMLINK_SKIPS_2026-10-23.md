# Five Windows file-symlink skips — 2026-10-23

The skips are genuine missing host capability, not incorrect detection. This
non-elevated process has neither enabled Developer Mode nor
`SeCreateSymbolicLinkPrivilege`. Explicit file links fail with EPERM; directory
junctions succeed. No registry, privilege, execution-policy, ACL, volume or other
system setting was changed, and no elevated process was run.

## What remains unexecuted

| Test | Boundary it would verify |
|---|---|
| `tests/review-windows-native.test.ts` — `[G7:FILE_SYMLINK] rejects an actual file symlink to an outside file` | Establish a real readable outside file symlink, then require hardened snapshot preparation to reject it with SNAPSHOT_ALIAS. |
| `tests/workspace-config.test.ts` — `blocks a native outside file symlink for package.json when available` | Config reader rejects the real link before opening the outside package metadata. |
| `tests/workspace-config.test.ts` — `blocks a native outside file symlink for .c2cignore when available` | Config reader rejects outside ignore rules before opening them. |
| `tests/workspace-config.test.ts` — `blocks a native outside file symlink for .c2c.json when available` | Config reader rejects outside project settings before opening them. |
| `tests/windows-legacy.test.ts` — `CANNOT_VERIFY: file symlink escape proof (symbolic links unavailable)` | When capability exists, `rejects a file symlink escaping the workspace` runs and requires PATH_OUTSIDE_WORKSPACE. The skip placeholder is replaced by the actual test. |

Junction, hardlink and mocked lstat tests do not replace these five native proofs.

## Host evidence

Read-only registry query:
`Get-ItemProperty HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock`,
selecting only `AllowDevelopmentWithoutDevLicense`. Privileges came from
`& "$env:SystemRoot\System32\whoami.exe" /priv`; using the absolute Windows
executable matters because plain `whoami` on this PATH resolves to Git's GNU
version, which rejects `/priv`.

```text
Host: ACHIH-MAIN
Node: v24.19.0
Elevated administrator token: False
Windows: EditionID=Core; DisplayVersion=25H2; CurrentBuild=26200
AllowDevelopmentWithoutDevLicense: VALUE_ABSENT

SeShutdownPrivilege           Disabled
SeChangeNotifyPrivilege       Enabled
SeUndockPrivilege             Disabled
SeIncreaseWorkingSetPrivilege Disabled
SeTimeZonePrivilege           Disabled
SeCreateSymbolicLinkPrivilege present: False

{"type":"file","result":"denied","code":"EPERM","errno":-4048,"syscall":"symlink"}
{"type":"default","result":"denied","code":"EPERM","errno":-4048,"syscall":"symlink"}
{"type":"junction","result":"created","isSymbolicLink":true,"targetMatches":true}
junction target preserved: true
probe cleanup: true
```

The Node probe created only synthetic targets under this worktree's `_working/`,
called `fs.symlinkSync` with `file`, omitted type, and `junction`, then removed
its own bounded fixture. The successful junction and preserved target distinguish
missing file-link privilege from an unwritable fixture directory. The registry
value is absent, not an observed numeric zero; together with the token and actual
creation failure, this establishes the missing capability for this process.

## Availability detection

The G7 test and all three config tests explicitly pass `"file"` and skip only on
EPERM; other errors fail. `tests/helpers.ts:canCreateFileSymlink` creates a real
regular target file and omits type. Node detects that target as a file, so this is
also a file-link probe, not a junction probe. The legacy test uses that helper
and the same target-file pattern. Both forms returned EPERM here. No detection
fix or skip suppression is justified. See the [Node 24.19.0 symlink API](https://nodejs.org/download/release/v24.19.0/docs/api/fs.html#fssymlinksynctarget-path-type).

## Owner action and trade-off

For this Windows 11 25H2 Home host, the direct option is **Settings > System >
Advanced > For developers > Developer Mode > On**, accepting the administrator
prompt personally. Then open a fresh ordinary, non-elevated terminal and rerun
the tests. Older Windows versions place the toggle on the separate For developers
page. Device Portal and Device Discovery are separate options and are unnecessary
for this task. [Microsoft's settings documentation](https://learn.microsoft.com/en-us/windows/advanced-settings/developer-mode)

Developer Mode is machine-wide, not limited to this repository. It permits
unprivileged symlink creation by compatible applications and enables additional
app development/deployment functionality. Node 24.19.0's bundled libuv requests
`SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE`. This expands what software running
as the user can arrange in writable directories; software that follows links
unsafely may be exposed to link-substitution attacks. It does not itself grant
read access through a target's ACL. [Microsoft symlink guidance](https://blogs.windows.com/windowsdeveloper/2016/12/02/symlinks-windows-10/),
[Node's bundled Windows implementation](https://github.com/nodejs/node/blob/v24.19.0/deps/uv/src/win/fs.c)

An alternative, on an edition with supported local/domain policy management, is
an administrator assigning **Create symbolic links** to a trusted test account
under **Local Policies > User Rights Assignment**, followed by sign-out/sign-in
and a new ordinary terminal. Confirm that its effective token actually contains
`SeCreateSymbolicLinkPrivilege`; membership in Administrators alone is not proof
for a UAC-filtered token. This Home edition does not provide the standard local
policy editors, so this document does not prescribe installing an unofficial
editor or changing UAC. Granting the right persists across projects and should
be limited to a trusted account. [Microsoft privilege policy](https://learn.microsoft.com/windows/security/threat-protection/security-policy-settings/create-symbolic-links),
[Git for Windows' UAC/edition notes](https://github.com/git-for-windows/git-for-windows.github.io/blob/main/content/symbolic-links.md)

Keeping the current settings and retaining five explicit skips is also a valid
owner decision. Do not elevate the entire test suite merely to make it green.
No `fsutil behavior set`, registry write, or system-setting command was executed.

After an owner-approved change, from this worktree:

```powershell
$env:CI='true'
corepack pnpm exec vitest run tests/workspace-config.test.ts tests/windows-legacy.test.ts tests/review-windows-native.test.ts
```

Confirm the five named proofs execute and pass, with **zero skipped and zero
failed** in that run. If file creation still fails, inspect the effective token
and policy rather than changing detection to pretend capability exists. This
targeted run does not establish other-reparse/cross-account ACL evidence and is
not a strict G7 acceptance or external C2C authorization.
