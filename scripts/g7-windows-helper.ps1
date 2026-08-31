[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateNotNullOrEmpty()]
  [string]$ManifestPath,
  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# A PS7 caller can export incompatible module paths into this PS5.1 process.
$env:PSModulePath = Join-Path $PSHOME 'Modules'

# This helper intentionally accepts one data file only.  It never evaluates
# manifest content and only derives paths below this checkout's fixed fixture root.
# CmdletBinding rejects extra positional/named arguments before execution.
$script:FailurePath = $null
trap {
  $failure = $_
  if ($script:FailurePath) {
    try { Write-JsonEvidence $script:FailurePath @{ success = $false; error = $failure.Exception.Message; line = $failure.InvocationInfo.ScriptLineNumber } } catch { }
  }
  throw $failure
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class G7Native {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct USER_INFO_1 {
    public string usri1_name; public string usri1_password; public int usri1_password_age;
    public int usri1_priv; public string usri1_home_dir; public string usri1_comment;
    public int usri1_flags; public string usri1_script_path;
  }
  [DllImport("Netapi32.dll", CharSet=CharSet.Unicode)] public static extern int NetUserAdd(string servername, int level, ref USER_INFO_1 buf, out int parm_err);
  [DllImport("Netapi32.dll", CharSet=CharSet.Unicode)] public static extern int NetUserDel(string servername, string username);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool LogonUser(string name, string domain, string password, int logonType, int provider, out IntPtr token);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool CreateSymbolicLink(string link, string target, int flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetFileAttributes(string path);
  [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool DeviceIoControl(IntPtr handle, uint code, byte[] input, int inputSize, byte[] output, int outputSize, out int returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, System.Text.StringBuilder buffer, uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetLongPathName(string path, System.Text.StringBuilder buffer, uint length);
}
'@

function Fail([string]$Code) { throw "G7_HELPER_$Code" }
function Native-Path([string]$Path) {
  if ($Path.StartsWith('\\?\', [StringComparison]::Ordinal)) { return $Path }
  if ($Path.StartsWith('\\', [StringComparison]::Ordinal)) { return '\\?\UNC\' + $Path.Substring(2) }
  return '\\?\' + $Path
}
function Get-NativeFileAttributes([string]$Path, [string]$FailureCode) {
  $attributes = [G7Native]::GetFileAttributes((Native-Path $Path))
  if ($attributes -eq [Convert]::ToUInt32('FFFFFFFF', 16)) { Fail "$FailureCode`_$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  return [IO.FileAttributes]$attributes
}
function Sha256([string]$File) {
  $stream = [IO.File]::Open((Native-Path $File), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose(); $stream.Dispose() }
}
function Write-JsonEvidence([string]$Path, [object]$Value) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 8 -Compress))
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
}
function Exact-Properties([object]$Object, [string[]]$Names) {
  if ($null -eq $Object) { return $false }
  $actual = @($Object.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
  $expected = @($Names | Sort-Object)
  return $actual.Count -eq $expected.Count -and -not (Compare-Object $actual $expected)
}
function Get-ChildRelative([string]$Parent, [string]$Child) {
  # Windows PowerShell 5.1 targets .NET Framework, so use a scoped canonical prefix.
  $base = [IO.Path]::GetFullPath($Parent).TrimEnd([char]92)
  $full = [IO.Path]::GetFullPath($Child)
  $prefix = $base + [IO.Path]::DirectorySeparatorChar
  if ($full.Length -le $prefix.Length -or -not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $null }
  return $full.Substring($prefix.Length)
}
function Is-Child([string]$Parent, [string]$Child) {
  return $null -ne (Get-ChildRelative $Parent $Child)
}
function Assert-PlainDirectory([string]$Path, [string]$Parent = $null) {
  $full = [IO.Path]::GetFullPath($Path)
  if (-not [string]::IsNullOrEmpty($Parent) -and -not (Is-Child $Parent $full)) { Fail 'ROOT_ESCAPE' }
  $attributes = Get-NativeFileAttributes $full 'ROOT_ITEM'
  if (($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'ROOT_REPARSE' }
  return $full
}
function Assert-PlainPath([string]$Path, [string]$Root) {
  $full = [IO.Path]::GetFullPath($Path)
  if (-not (Is-Child $Root $full)) { Fail 'ARTIFACT_ESCAPE' }
  $current = $Root
  $relative = Get-ChildRelative $Root $full
  foreach ($part in $relative.Split([IO.Path]::DirectorySeparatorChar)) {
    $current = Join-Path $current $part
    $attributes = Get-NativeFileAttributes $current 'ARTIFACT_ITEM'
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'ARTIFACT_REPARSE' }
  }
  return $full
}
function Assert-PlainAds([string]$Path, [string]$Root) {
  $suffix = ':g7-native-ads'
  if (-not $Path.EndsWith($suffix, [StringComparison]::Ordinal)) { Fail 'ADS_STREAM' }
  $base = Assert-PlainPath $Path.Substring(0, $Path.Length - $suffix.Length) $Root
  if ($base -ne (Join-Path $Root 'hardened-repo\approved.txt')) { Fail 'MANIFEST_TARGET' }
  return $base + $suffix
}
function Sha256-Ads([string]$Path) {
  $base = $Path.Substring(0, $Path.Length - ':g7-native-ads'.Length)
  $bytes = [byte[]]@(Get-Content -LiteralPath $base -Stream 'g7-native-ads' -Encoding Byte -ReadCount 1 -TotalCount 1025)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}
function Get-Sid([string]$Name) {
  return ([Security.Principal.NTAccount]::new($env:COMPUTERNAME, $Name)).Translate([Security.Principal.SecurityIdentifier]).Value
}
function Assert-PrivateFile([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) { Fail 'ARTIFACT_ACL_INHERITANCE' }
  $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544' | Sort-Object -Unique)
  $seen = @{}
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { Fail 'ARTIFACT_ACL_RULE' }
    $sid = $rule.IdentityReference.Value
    if ($sid -notin $allowed -or (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) { Fail 'ARTIFACT_ACL_PRINCIPAL' }
    $seen[$sid] = $true
  }
  if ((@($seen.Keys | Sort-Object) -join ',') -ne ($allowed -join ',')) { Fail 'ARTIFACT_ACL_MISSING' }
}
function Assert-PrivateRoot([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) { Fail 'ROOT_ACL_INHERITANCE' }
  $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($sid -notin $allowed) { Fail 'ROOT_ACL_PRINCIPAL' }
  }
}
function Add-ControlAcl([string]$Path, [string]$Sid) {
  $acl = Get-Acl -LiteralPath $Path
  $identity = [Security.Principal.SecurityIdentifier]::new($Sid)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::Modify, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule) | Out-Null
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Fixture-UserName([string]$Nonce) {
  if ($Nonce -notmatch '^[a-f0-9]{32}$') { Fail 'ACCOUNT_NONCE' }
  return "g7n$($Nonce.Substring(0, 16))"
}
function Add-LocalFixtureUser([string]$Nonce) {
  $name = Fixture-UserName $Nonce
  $bytes = New-Object byte[] 36; $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $password = [Convert]::ToBase64String($bytes).Replace('+','A').Replace('/','B').Replace('=','C') + 'aA1!'
  $info = [G7Native+USER_INFO_1]::new(); $info.usri1_name = $name; $info.usri1_password = $password; $info.usri1_priv = 1; $info.usri1_flags = 0x1
  [int]$parameter = 0; $status = [G7Native]::NetUserAdd($null, 1, [ref]$info, [ref]$parameter)
  if ($status -ne 0) { Fail "USER_ADD_$status" }
  $sid = Get-Sid $name
  $adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $groups = ([Security.Principal.WindowsIdentity]::GetCurrent()).Groups # Do not use the elevated token for the new-user assertion.
  return @{ Name = $name; Password = $password; Sid = $sid; AdminSid = $adminSid }
}
function Remove-OwnedUser([hashtable]$User) {
  $actual = Get-Sid $User.Name
  if ($actual -ne $User.Sid) { Fail 'ACCOUNT_SID_MISMATCH' }
  $status = [G7Native]::NetUserDel($null, $User.Name)
  if ($status -ne 0 -and $status -ne 2221) { Fail "USER_DELETE_$status" }
  $missing = $false; try { $null = Get-Sid $User.Name } catch { $missing = $true }
  if (-not $missing) { Fail 'ACCOUNT_STILL_EXISTS' }
}
function Short-Alias([string]$Path, [string]$Root) {
  $buffer = [Text.StringBuilder]::new(32768)
  $length = [G7Native]::GetShortPathName($Path, $buffer, $buffer.Capacity)
  if ($length -eq 0 -or $length -ge $buffer.Capacity) { Fail "SHORT_ALIAS_$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $short = $buffer.ToString(); $rootBuffer = [Text.StringBuilder]::new(32768)
  $rootLength = [G7Native]::GetShortPathName($Root, $rootBuffer, $rootBuffer.Capacity)
  if ($rootLength -eq 0 -or $rootLength -ge $rootBuffer.Capacity) { Fail "SHORT_ROOT_$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $shortRoot = $rootBuffer.ToString(); $longBuffer = [Text.StringBuilder]::new(32768)
  $longLength = [G7Native]::GetLongPathName($short, $longBuffer, $longBuffer.Capacity)
  if ($longLength -eq 0 -or $longLength -ge $longBuffer.Capacity -or [IO.Path]::GetFullPath($longBuffer.ToString()) -ne [IO.Path]::GetFullPath($Path)) { Fail 'SHORT_ALIAS_IDENTITY' }
  $rootLongBuffer = [Text.StringBuilder]::new(32768)
  $rootLongLength = [G7Native]::GetLongPathName($shortRoot, $rootLongBuffer, $rootLongBuffer.Capacity)
  if ($rootLongLength -eq 0 -or $rootLongLength -ge $rootLongBuffer.Capacity -or [IO.Path]::GetFullPath($rootLongBuffer.ToString()) -ne [IO.Path]::GetFullPath($Root)) { Fail 'SHORT_ROOT_IDENTITY' }
  # .NET Framework GetFullPath expands 8.3 names; preserve the verified native spelling.
  $shortPrefix = $shortRoot.TrimEnd([char]92) + [IO.Path]::DirectorySeparatorChar
  if (-not $short.StartsWith($shortPrefix, [StringComparison]::OrdinalIgnoreCase)) { Fail 'SHORT_ROOT_ESCAPE' }
  $relative = $short.Substring($shortPrefix.Length)
  if ([IO.Path]::GetFileName($short).ToLowerInvariant() -eq [IO.Path]::GetFileName($Path).ToLowerInvariant() -or -not (Is-Child $shortRoot $short)) { Fail 'SHORT_ALIAS_UNAVAILABLE' }
  return @{ path = $short; relative = ($relative -replace '\\','/') }
}
function Denied-Access([string]$Path, [bool]$Write) {
  try {
    $access = if ($Write) { [IO.FileAccess]::Write } else { [IO.FileAccess]::Read }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, $access, [IO.FileShare]::ReadWrite)
    try { } finally { $stream.Dispose() }
    Fail 'IMPERSONATED_ACCESS_ALLOWED'
  } catch [UnauthorizedAccessException] { return 'UnauthorizedAccess' }
    catch [IO.IOException] { if ($_.Exception.HResult -eq -2147024891) { return 'ERROR_ACCESS_DENIED' }; Fail "IMPERSONATED_IO_$($_.Exception.HResult)" }
    catch { Fail "IMPERSONATED_$($_.Exception.GetType().Name)" }
}
function Control-Access([string]$Path) {
  $read = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); try { $null = $read.ReadByte() } finally { $read.Dispose() }
  $write = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite); try { $write.WriteByte(0x43) } finally { $write.Dispose() }
}
function Reparse-Tag([string]$Path) {
  $invalid = [IntPtr](-1); $handle = [G7Native]::CreateFile($Path, [Convert]::ToUInt32('80000000', 16), 3, [IntPtr]::Zero, 3, 0x00200000, [IntPtr]::Zero)
  if ($handle -eq $invalid) { Fail "REPARSE_OPEN_$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  try {
    $output = New-Object byte[] 16384; [int]$returned = 0
    if (-not [G7Native]::DeviceIoControl($handle, 0x000900A8, $null, 0, $output, $output.Length, [ref]$returned, [IntPtr]::Zero)) { Fail "REPARSE_GET_$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    if ($returned -lt 8) { Fail 'REPARSE_SHORT' }
    return [BitConverter]::ToUInt32($output, 0)
  } finally { [void][G7Native]::CloseHandle($handle) }
}
function Create-LxFifo([string]$Path) {
  [IO.File]::WriteAllText($Path, 'synthetic reparse placeholder', [Text.Encoding]::ASCII)
  $invalid = [IntPtr](-1); $handle = [G7Native]::CreateFile($Path, 0x40000000, 0, [IntPtr]::Zero, 3, 0x00200000, [IntPtr]::Zero)
  if ($handle -eq $invalid) { Fail "REPARSE_CREATE_$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  try {
    # REPARSE_DATA_BUFFER: LX_FIFO tag, zero data length/reserved, and no payload.
    $input = [BitConverter]::GetBytes($script:LxFifoTag)
    $input += [byte[]](0, 0, 0, 0)
    [int]$returned = 0
    if (-not [G7Native]::DeviceIoControl($handle, 0x000900A4, $input, 8, $null, 0, [ref]$returned, [IntPtr]::Zero)) { Fail "REPARSE_SET_$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  } finally { [void][G7Native]::CloseHandle($handle) }
  $tag = Reparse-Tag $Path
  $item = Get-Item -LiteralPath $Path -Force
  if ($tag -ne $script:LxFifoTag -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -or $item.LinkType -in @('SymbolicLink', 'Junction')) { Fail 'REPARSE_VERIFY' }
  return @{ path = $Path; tag = $tag; attributes = [int]$item.Attributes; isSymbolicLink = ($item.LinkType -eq 'SymbolicLink'); isJunction = ($item.LinkType -eq 'Junction') }
}

$script:LxFifoTag = [Convert]::ToUInt32('80000024', 16)

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tooling = Assert-PlainDirectory (Join-Path $repoRoot '.tooling')
$manifestFile = [IO.Path]::GetFullPath($ManifestPath)
if (-not (Is-Child $tooling $manifestFile) -or (Split-Path -Leaf $manifestFile) -ne 'manifest.json') { Fail 'MANIFEST_PATH' }
$fixtureRoot = Assert-PlainDirectory (Split-Path -Parent $manifestFile) $tooling
if ((Split-Path -Leaf $fixtureRoot) -notmatch '^g7-native-([a-f0-9]{32})$') { Fail 'FIXTURE_NAME' }
$manifestText = Get-Content -LiteralPath $manifestFile -Raw
if ([Text.Encoding]::UTF8.GetByteCount($manifestText) -gt 49152) { Fail 'MANIFEST_SIZE' }
$manifest = $manifestText | ConvertFrom-Json
if (-not (Exact-Properties $manifest @('schemaVersion','nonce','root','mode','helperStartExpiresAt','evidenceExpiresAt','fingerprints','artifacts')) -or $manifest.schemaVersion -ne 1 -or $manifest.nonce -ne $matches[1] -or $manifest.root -ne $fixtureRoot -or $manifest.mode -notin @('run','cleanup') -or $manifest.helperStartExpiresAt -isnot [long] -or $manifest.evidenceExpiresAt -isnot [long] -or $manifest.evidenceExpiresAt -le $manifest.helperStartExpiresAt) { Fail 'MANIFEST_SCHEMA' }
Assert-PrivateRoot $fixtureRoot
$script:FailurePath = Join-Path $fixtureRoot 'helper-failure.json'
$user = $null; $receipt = Join-Path $fixtureRoot 'cleanup-receipt.json'; $resultFile = Join-Path $fixtureRoot 'helper-result.json'
if ($ValidateOnly -and $manifest.mode -ne 'run') { Fail 'VALIDATION_MODE' }
if ($manifest.mode -eq 'cleanup') {
  if (-not (Test-Path -LiteralPath $receipt -PathType Leaf)) { Fail 'CLEANUP_RECEIPT_MISSING' }
  $saved = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
  if (-not (Exact-Properties $saved @('nonce','accountName','accountSid','createdByHelper')) -or $saved.nonce -ne $manifest.nonce -or $saved.createdByHelper -ne $true -or $saved.accountName -ne (Fixture-UserName $manifest.nonce) -or $saved.accountSid -notmatch '^S-1-5-21-') { Fail 'CLEANUP_RECEIPT_INVALID' }
  Remove-OwnedUser @{ Name = $saved.accountName; Sid = $saved.accountSid }
  exit 0
}
if (-not (Exact-Properties $manifest.fingerprints @('scripts/verify-g7-windows.mjs','scripts/g7-windows-helper.ps1','src/review/private-storage.ts','src/review/session.ts','src/review/snapshot.ts','src/auth/store.ts','dist/review/private-storage.js','dist/review/session.js','dist/review/snapshot.js','dist/auth/store.js'))) { Fail 'FINGERPRINT_SCHEMA' }
foreach ($relative in $manifest.fingerprints.PSObject.Properties.Name) {
  if ($manifest.fingerprints.$relative -notmatch '^[a-f0-9]{64}$') { Fail 'FINGERPRINT_VALUE' }
  $candidate = [IO.Path]::GetFullPath((Join-Path $repoRoot $relative))
  if (-not (Is-Child $repoRoot $candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf) -or (Sha256 $candidate) -ne $manifest.fingerprints.$relative) { Fail 'FINGERPRINT_CHANGED' }
}
if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$manifest.helperStartExpiresAt) { Fail 'MANIFEST_EXPIRED' }
if (-not (Exact-Properties $manifest.artifacts @('snapshot','auth','state','audit','lock','outside','ads','longPath','shortSource'))) { Fail 'MANIFEST_ARTIFACT_SCHEMA' }
$required = @{
  snapshot = '^private-snapshot\.json$'
  auth = '^private-state\\\.c2c-review-private\\[a-f0-9]{64}\.auth\.json$'
  state = '^private-state\\\.c2c-review-private\\state-private\.txt$'
  audit = '^private-state\\\.c2c-review-private\\[a-f0-9]{64}\.audit\.jsonl$'
  lock = '^private-state\\\.c2c-review-private\\[a-f0-9]{64}\.lock$'
  outside = '^outside\\outside\.txt$'
  ads = '^hardened-repo\\approved\.txt:g7-native-ads$'
  longPath = '^hardened-repo\\(?:native-long-[0-9]{2}-x{40}\\)+safe\.txt$'
  shortSource = '^hardened-repo\\native-short-alias-x{56}\.txt$'
}
$protectedHashes = @{}
foreach ($name in $required.Keys) {
  $entry = $manifest.artifacts.$name
  if ($null -eq $entry -or -not (Exact-Properties $entry @('path','sha256')) -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { Fail 'MANIFEST_ARTIFACT' }
  if ($name -eq 'ads') {
    # .NET Framework rejects ADS in GetFullPath; validate the base and fixed stream separately.
    $target = Assert-PlainAds $entry.path $fixtureRoot
    $relative = 'hardened-repo\approved.txt:g7-native-ads'
    $digest = Sha256-Ads $target
  } else {
    $target = Assert-PlainPath $entry.path $fixtureRoot
    $relative = Get-ChildRelative $fixtureRoot $target
    $digest = Sha256 $target
  }
  if ($relative -notmatch $required[$name]) { Fail 'MANIFEST_TARGET' }
  if ($digest -ne $entry.sha256) { Fail 'MANIFEST_DIGEST' }
  if ($name -in @('snapshot','auth','state','audit','lock')) { Assert-PrivateFile $target; $protectedHashes[$name] = $entry.sha256 }
}

$shortAlias = Short-Alias $manifest.artifacts.shortSource.path (Join-Path $fixtureRoot 'hardened-repo')
if ($ValidateOnly) { exit 0 }

try {
  $hard = Assert-PlainDirectory (Join-Path $fixtureRoot 'hardened-repo') $fixtureRoot
  $legacy = Assert-PlainDirectory (Join-Path $fixtureRoot 'legacy-repo') $fixtureRoot
  $outside = Assert-PlainDirectory (Join-Path $fixtureRoot 'outside') $fixtureRoot
  $target = Assert-PlainPath (Join-Path $outside 'outside.txt') $fixtureRoot
  $fileLink = Join-Path $hard 'outside-file-link.txt'; $legacyLink = Join-Path $legacy 'outside-file-link.txt'; $reparse = Join-Path $hard 'other-reparse'
  foreach ($link in @($fileLink, $legacyLink)) { if (-not [G7Native]::CreateSymbolicLink($link, $target, 0)) { Fail "SYMLINK_$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" } }
  $nested = Join-Path $hard 'nested'; [IO.Directory]::CreateDirectory($nested) | Out-Null
  $junction = Join-Path $nested 'redirect'; New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
  $junctionItem = Get-Item -LiteralPath $junction -Force
  if (($junctionItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -or $junctionItem.LinkType -ne 'Junction') { Fail 'JUNCTION_VERIFY' }
  $reparseEvidence = Create-LxFifo $reparse
  $user = Add-LocalFixtureUser $manifest.nonce
  Write-JsonEvidence $receipt @{ nonce = $manifest.nonce; accountName = $user.Name; accountSid = $user.Sid; createdByHelper = $true }
  $controls = Join-Path $fixtureRoot 'acl-controls'; [IO.Directory]::CreateDirectory($controls) | Out-Null; Add-ControlAcl $controls 'S-1-5-32-545'; Add-ControlAcl $controls 'S-1-1-0'
  $usersControl = Join-Path $controls 'users-control.txt'; $everyoneControl = Join-Path $controls 'everyone-control.txt'; [IO.File]::WriteAllText($usersControl, 'U', [Text.Encoding]::ASCII); [IO.File]::WriteAllText($everyoneControl, 'E', [Text.Encoding]::ASCII); Add-ControlAcl $usersControl 'S-1-5-32-545'; Add-ControlAcl $everyoneControl 'S-1-1-0'
  $token = [IntPtr]::Zero
  if (-not [G7Native]::LogonUser($user.Name, $env:COMPUTERNAME, $user.Password, 2, 0, [ref]$token)) { Fail "LOGON_$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  try {
    $identity = [Security.Principal.WindowsIdentity]::new($token); $groupSids = @($identity.Groups | ForEach-Object { $_.Value })
    if ($groupSids -notcontains 'S-1-5-32-545' -or $groupSids -notcontains 'S-1-1-0' -or $groupSids -contains 'S-1-5-32-544') { Fail 'TOKEN_GROUPS' }
    $context = [Security.Principal.WindowsIdentity]::Impersonate($token)
    try {
      Control-Access $usersControl; Control-Access $everyoneControl
      $denied = @{ snapshot = Denied-Access $manifest.artifacts.snapshot.path $false; auth = Denied-Access $manifest.artifacts.auth.path $false; state = Denied-Access $manifest.artifacts.state.path $true; audit = Denied-Access $manifest.artifacts.audit.path $true; lock = Denied-Access $manifest.artifacts.lock.path $true }
    } finally { $context.Undo() }
  } finally { if ($token -ne [IntPtr]::Zero) { [void][G7Native]::CloseHandle($token) } }
  foreach ($name in $protectedHashes.Keys) { if ((Sha256 $manifest.artifacts.$name.path) -ne $protectedHashes[$name]) { Fail "ARTIFACT_HASH_CHANGED_$name" } }
  $ownerRead = [IO.File]::ReadAllText($manifest.artifacts.snapshot.path).Length -gt 0 -and [IO.File]::ReadAllText($manifest.artifacts.auth.path).Length -gt 0
  $ownerWrite = $true
  Remove-OwnedUser $user; $user = $null
  $result = @{ success = $true; nonce = $manifest.nonce; reparse = $reparseEvidence; junction = @{ path = $junction; linkType = $junctionItem.LinkType }; shortAlias = $shortAlias; acl = @{ controls = @{ usersReadWrite = $true; everyoneReadWrite = $true }; denied = $denied; owner = @{ read = $ownerRead; write = $ownerWrite }; token = @{ users = $true; everyone = $true } }; cleanup = @{ userNotFound = $true; accountSid = (Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json).accountSid; receipt = $receipt } }
  Write-JsonEvidence $resultFile $result
} finally {
  if ($null -ne $user) { Remove-OwnedUser $user }
}
