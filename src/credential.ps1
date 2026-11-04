param([Parameter(Mandatory=$true)][ValidateSet('write','read','exists','delete')][string]$Action,
      [Parameter(Mandatory=$true)][string]$Target)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TaskCredentials {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Credential {
    public int Flags, Type; public string TargetName, Comment; public long LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist, AttributeCount;
    public IntPtr Attributes; public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CredWriteW")] public static extern bool Write(ref Credential credential, int flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CredReadW")] public static extern bool Read(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CredDeleteW")] public static extern bool Delete(string target, int type, int flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
if ($Action -eq 'write') {
  $secret = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($secret)) { throw 'Empty secret' }
  $bytes = [System.Text.Encoding]::Unicode.GetBytes($secret)
  if ($bytes.Length -gt 2560) { throw 'Secret too long' }
  $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
    $c = New-Object TaskCredentials+Credential
    $c.Type=1; $c.TargetName=$Target; $c.UserName='LiteLLM'; $c.Persist=2
    $c.CredentialBlobSize=$bytes.Length; $c.CredentialBlob=$ptr
    if (-not [TaskCredentials]::Write([ref]$c, 0)) { throw 'Credential write failed' }
  } finally { [Array]::Clear($bytes, 0, $bytes.Length); [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr) }
} elseif ($Action -eq 'delete') {
  if (-not [TaskCredentials]::Delete($Target, 1, 0)) { if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Credential delete failed' } }
} else {
  $ptr=[IntPtr]::Zero
  if (-not [TaskCredentials]::Read($Target, 1, 0, [ref]$ptr)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 3 }
    throw 'Credential read failed'
  }
  try {
    if ($Action -eq 'read') {
      $c=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][TaskCredentials+Credential])
      $secret=[Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, [int]($c.CredentialBlobSize / 2))
      [Console]::Out.Write($secret)
    }
  } finally { [TaskCredentials]::CredFree($ptr) }
}
