# Secure input: no API key literal in PowerShell history or ChatGPT.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
New-Item -ItemType Directory -Force 'secrets' | Out-Null
$secret=Read-Host 'Paste OpenAI tunnel RUNTIME API key (hidden)' -AsSecureString
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ($plain.Length -lt 12 -or $plain.Contains("`n") -or $plain.Contains("`r")) { throw 'Invalid key format' }
  [IO.File]::WriteAllText((Join-Path (Get-Location).Path 'secrets/openai-runtime-key.txt'), $plain)
  Write-Host 'Runtime key stored in local, gitignored file; it was not printed.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  Remove-Variable plain -ErrorAction SilentlyContinue
}
# On Windows, restrict this file's ACL to the current user and SYSTEM where possible.
$keyPath=Join-Path (Get-Location).Path 'secrets/openai-runtime-key.txt'
try {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $keyPath /inheritance:r /grant:r ("{0}:(R,W)" -f $identity) 'SYSTEM:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Check the runtime key file ACL manually.' }
} catch { Write-Warning 'Could not apply Windows ACL automatically; secure this local secret file.' }
