param([string]$SdkRoot = $env:ANDROID_HOME, [switch]$SkipWebBuild, [switch]$WithTests)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $SdkRoot) { $SdkRoot = Join-Path $projectRoot '.work\android-sdk' }
$SdkRoot = (Resolve-Path -LiteralPath $SdkRoot).Path
$signingRoot = Join-Path $projectRoot '.private\android'
$keyFile = Join-Path $signingRoot '2048-sandbox-release.jks'
$secretFile = Join-Path $signingRoot 'password.dpapi'
New-Item -ItemType Directory -Path $signingRoot -Force | Out-Null
Push-Location $projectRoot
try {
    if (-not $SkipWebBuild) {
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
        & node scripts/package-release.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Local package failed' }
        & pnpm build:android
        if ($LASTEXITCODE -ne 0) { throw 'Android web build failed' }
    }
    & node scripts/prepare-android.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Android asset preparation failed' }
    if ((Test-Path -LiteralPath $keyFile) -ne (Test-Path -LiteralPath $secretFile)) { throw 'Incomplete signing files. Restore the original key and DPAPI password together.' }
    if (-not (Test-Path -LiteralPath $keyFile)) {
        $randomBytes = New-Object byte[] 36
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        $random.GetBytes($randomBytes); $random.Dispose()
        $newPassword = [Convert]::ToBase64String($randomBytes)
        $newPassword | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $secretFile -Encoding ASCII
    }
    $securePassword = (Get-Content -LiteralPath $secretFile -Raw).Trim() | ConvertTo-SecureString
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try { $env:SANDBOX_STORE_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
    if (-not (Test-Path -LiteralPath $keyFile)) {
        & keytool -genkeypair -keystore $keyFile -storetype JKS -alias '2048-sandbox' -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=2048 Sandbox' -storepass:env SANDBOX_STORE_PASSWORD -keypass:env SANDBOX_STORE_PASSWORD
        if ($LASTEXITCODE -ne 0) { throw 'Release signing key generation failed' }
    }
    $env:SANDBOX_KEYSTORE = $keyFile
    $env:ANDROID_HOME = $SdkRoot
    $gradleArguments = @('-p', 'android', 'assembleRelease', '--no-daemon', '--console=plain')
    if ($WithTests) { $gradleArguments += @('-PnativeTestBuildType=release', 'assembleReleaseAndroidTest') }
    & '.\android\gradlew.bat' @gradleArguments
    if ($LASTEXITCODE -ne 0) { throw 'Android build failed' }
    $product = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
    $apkName = "2048-sandbox-v$($product.version)-android.apk"
    $apkFile = Join-Path $projectRoot "release\$apkName"
    Copy-Item -LiteralPath 'android\app\build\outputs\apk\release\app-release.apk' -Destination $apkFile -Force
    $signer = Join-Path $SdkRoot 'build-tools\35.0.0\apksigner.bat'
    & $signer verify --verbose --print-certs $apkFile
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
    $digest = (Get-FileHash -LiteralPath $apkFile -Algorithm SHA256).Hash.ToLowerInvariant()
    "$digest  $apkName" | Set-Content -LiteralPath "$apkFile.sha256" -Encoding ASCII
    Write-Output "Signed Android release: $apkFile"
} finally {
    Remove-Item Env:\SANDBOX_STORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\SANDBOX_KEYSTORE -ErrorAction SilentlyContinue
    Pop-Location
}
