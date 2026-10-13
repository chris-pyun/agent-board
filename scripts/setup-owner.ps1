$ErrorActionPreference = 'Stop'
$kanbanSecret = Read-Host '소유자 비밀번호 (12자 이상)' -AsSecureString
$kanbanPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($kanbanSecret)
try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($kanbanPointer) | node build/src/server/setup.js
    if ($LASTEXITCODE -ne 0) { throw '비밀번호 설정 실패' }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($kanbanPointer)
    $kanbanSecret.Dispose()
}
