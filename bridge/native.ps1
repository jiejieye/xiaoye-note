$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
try { $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json }
catch { '{"error":"本机操作输入格式无效"}'; exit 1 }
try {
  Add-Type -AssemblyName System.Drawing, System.Windows.Forms, System.Security
  $value = switch ($inputValue.op) {
    'clipboard' {
      switch ($inputValue.action) {
        'text' { [Windows.Forms.Clipboard]::GetText() }
        'writeText' { [Windows.Forms.Clipboard]::SetText([string]$inputValue.text); $true }
        'image' {
          if ([Windows.Forms.Clipboard]::ContainsImage()) {
            $image = [Windows.Forms.Clipboard]::GetImage()
            $stream = [IO.MemoryStream]::new()
            try { $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($stream.ToArray()) }
            finally { $image.Dispose(); $stream.Dispose() }
          } else { '' }
        }
        'writeImage' {
          $stream = [IO.MemoryStream]::new([Convert]::FromBase64String($inputValue.bytes))
          $image = [Drawing.Image]::FromStream($stream)
          try { [Windows.Forms.Clipboard]::SetImage($image); $true }
          finally { $image.Dispose(); $stream.Dispose() }
        }
      }
    }
    'encrypt' { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($inputValue.text), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)) }
    'decrypt' { [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputValue.bytes), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)) }
    'unprotect' { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputValue.bytes), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)) }
    'startup' {
      $runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
      $entry = 'com.xiaoye.note.public'
      $command = '"' + $inputValue.executable + '"'
      if ($inputValue.enabled) {
        if (!(Test-Path -LiteralPath $runPath)) { New-Item -Path $runPath -Force | Out-Null }
        Set-ItemProperty -LiteralPath $runPath -Name $entry -Value $command
      } elseif ((Test-Path -LiteralPath $runPath) -and (Get-Item -LiteralPath $runPath).GetValue($entry) -eq $command) {
        Remove-ItemProperty -LiteralPath $runPath -Name $entry
      }
      $true
    }
    'startupStatus' {
      $runKey = Get-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
      $expected = '"' + $inputValue.executable + '"'
      @{ openAtLogin = ($null -ne $runKey -and $runKey.GetValue('com.xiaoye.note.public') -eq $expected) }
    }
  }
  @{value=$value} | ConvertTo-Json -Compress -Depth 8
} catch { @{error=$_.Exception.Message} | ConvertTo-Json -Compress }
