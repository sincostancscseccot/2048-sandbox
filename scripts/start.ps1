param(
    [switch]$Development,
    [switch]$Rebuild,
    [ValidateRange(1024, 65535)][int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeApplication = Get-Command 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$runtimeNodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodeCandidatePaths = @()
if ($nodeApplication) { $nodeCandidatePaths += $nodeApplication.Source }
if (Test-Path -LiteralPath $runtimeNodePath) { $nodeCandidatePaths += $runtimeNodePath }
$selectedNodePath = $null
foreach ($nodeCandidatePath in ($nodeCandidatePaths | Select-Object -Unique)) {
    try {
        $nodeVersionOutput = & $nodeCandidatePath '--version'
        if ($LASTEXITCODE -ne 0) { continue }
        $nodeCandidateVersion = [version]($nodeVersionOutput.Trim().TrimStart('v'))
        if ($nodeCandidateVersion.Major -eq 24 -and $nodeCandidateVersion -ge [version]'24.19.0') {
            $selectedNodePath = $nodeCandidatePath
            Write-Host "Using Node.js $nodeCandidateVersion."
            break
        }
    } catch { continue }
}
if (-not $selectedNodePath) { throw 'Install Node.js 24.19+ (24.x), then start again. A complete release does not require pnpm install.' }

Push-Location -LiteralPath $projectDirectory
try {
    $env:PATH = (Split-Path -Parent $selectedNodePath) + ';' + $env:PATH
    if ($Development) {
        if (-not (Test-Path -LiteralPath 'node_modules\vite\bin\vite.js')) { throw 'Dependencies are missing. Run pnpm install first.' }
        & $selectedNodePath 'node_modules\vite\bin\vite.js' '--host' '127.0.0.1' '--port' $Port '--strictPort'
    } else {
        if ($Rebuild -or -not (Test-Path -LiteralPath 'dist\index.html')) {
            if (-not (Test-Path -LiteralPath 'node_modules\vite\bin\vite.js')) { throw 'A build requires source dependencies. Extract a complete release or run pnpm install first.' }
            & $selectedNodePath 'node_modules\typescript\bin\tsc' '--noEmit'
            if ($LASTEXITCODE -ne 0) { throw 'Type checking failed.' }
            & $selectedNodePath 'node_modules\vite\bin\vite.js' 'build'
            if ($LASTEXITCODE -ne 0) { throw 'Production build failed.' }
        }
        & $selectedNodePath 'scripts\serve-release.mjs' '--port' $Port
    }
    if ($LASTEXITCODE -ne 0) { throw "Server exited with code $LASTEXITCODE. Check whether the port is already in use." }
} finally { Pop-Location }
