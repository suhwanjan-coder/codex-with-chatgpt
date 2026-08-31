[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [ValidateNotNullOrEmpty()]
  [string[]]$LiteralTargets
)

$ErrorActionPreference = "Stop"

function Get-SidValue {
  param([System.Security.Principal.IdentityReference]$Identity)

  try {
    return $Identity.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    return $null
  }
}

function Get-AclEvidence {
  param([string]$LiteralTarget)

  try {
    $item = Get-Item -LiteralPath $LiteralTarget -Force -ErrorAction Stop
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    $ownerSid = Get-SidValue -Identity $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      [pscustomobject]@{
        identitySid = $_.IdentityReference.Value
        accessControlType = [int]$_.AccessControlType
        fileSystemRights = [int64]$_.FileSystemRights
        inheritanceFlags = [int]$_.InheritanceFlags
        propagationFlags = [int]$_.PropagationFlags
        isInherited = [int][bool]$_.IsInherited
      }
    }

    return [pscustomobject]@{
      target = $item.FullName
      itemType = if ($item.PSIsContainer) { "directory" } else { "file" }
      ownerSid = $ownerSid
      accessRulesProtected = [int][bool]$acl.AreAccessRulesProtected
      auditRulesProtected = [int][bool]$acl.AreAuditRulesProtected
      daclRuleCount = @($rules).Count
      dacl = @($rules)
    }
  } catch {
    return [pscustomobject]@{
      target = $LiteralTarget
      errorType = $_.Exception.GetType().FullName
      errorHResult = [int]$_.Exception.HResult
    }
  }
}

[pscustomobject]@{
  schemaVersion = 1
  capturedAtUtc = [DateTime]::UtcNow.ToString("o")
  probe = "Get-Acl"
  targets = @($LiteralTargets | ForEach-Object { Get-AclEvidence -LiteralTarget $_ })
} | ConvertTo-Json -Depth 8
