# dev/lib/cred.ps1 — 從 Windows 憑證管理員讀 Supabase access token（sbp_…）。
#
# 用法（dot-source 後在同一個行程裡用，不要把結果印出來）：
#   . "$PSScriptRoot/../lib/cred.ps1"
#   $env:SUPABASE_ACCESS_TOKEN = Get-SupabaseToken
#
# 優先序：憑證管理員「Supabase CLI:supabase」（Generic，UTF-8 blob）→ $env:SUPABASE_ACCESS_TOKEN。
# 憑證管理員優先：2026-11-21 發現這台機器的使用者環境變數裡留著一把已失效的舊 token。
# token 只活在記憶體裡；本檔與呼叫端都不寫檔、不輸出。

if (-not ('CW.Cred' -as [type])) {
  Add-Type -Namespace CW -Name Cred -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment;
  public long LastWritten; public int CredentialBlobSize; public System.IntPtr CredentialBlob;
  public int Persist; public int AttributeCount; public System.IntPtr Attributes;
  public string TargetAlias; public string UserName;
}
[System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
public static extern bool CredReadW(string target, int type, int flags, out System.IntPtr cred);
[System.Runtime.InteropServices.DllImport("advapi32.dll")]
public static extern void CredFree(System.IntPtr cred);
'@
}

function Get-SupabaseToken {
  param([string]$Target = 'Supabase CLI:supabase')
  $p = [IntPtr]::Zero
  if (-not [CW.Cred]::CredReadW($Target, 1, 0, [ref]$p)) {
    if ($env:SUPABASE_ACCESS_TOKEN) { return $env:SUPABASE_ACCESS_TOKEN }
    throw "憑證管理員找不到「$Target」。到 supabase.com → Account → Access Tokens 產一把，用 cmdkey /generic:`"$Target`" /user:supabase /pass:<token> 存進去。"
  }
  try {
    $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][CW.Cred+CREDENTIAL])
    $bytes = New-Object byte[] $c.CredentialBlobSize
    [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
    $t = [Text.Encoding]::UTF8.GetString($bytes).Trim([char]0).Trim()
    # 有些工具存成 UTF-16：看起來不像 sbp_ 就改用 Unicode 解
    if ($t -notmatch '^sbp_') { $t = [Text.Encoding]::Unicode.GetString($bytes).Trim([char]0).Trim() }
    if ($t -notmatch '^sbp_') { throw "「$Target」裡的值不像 Supabase access token（應為 sbp_ 開頭）。" }
    return $t
  } finally { [CW.Cred]::CredFree($p) }
}
