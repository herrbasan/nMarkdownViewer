# nMarkdownViewer Release Script
# Creates a GitHub release with built artifacts (adapted from SoundApp).
#
# The updater (app/modules/electron_helper/update.js, source 'git') queries
# the GitHub API for the latest release of herrbasan/nMarkdownViewer and
# needs these assets attached: the Squirrel RELEASES file + *-full.nupkg
# (the setup.exe is for fresh installs).

param(
    [Parameter(Mandatory=$false)]
    [string]$Notes = "",

    [Parameter(Mandatory=$false)]
    [switch]$Draft,

    [Parameter(Mandatory=$false)]
    [switch]$Clean
)

$Repo = "herrbasan/nMarkdownViewer"
$Branch = "master"
$OutDir = Join-Path $PSScriptRoot "..\out"

# Read version from package.json
$packageJson = Get-Content -Path (Join-Path $PSScriptRoot "..\package.json") -Raw | ConvertFrom-Json
$Version = $packageJson.version

Write-Host "Creating nMarkdownViewer release v$Version" -ForegroundColor Green

# Check if GitHub CLI is installed
$ghPath = $null
try {
    $ghCmd = Get-Command gh -ErrorAction Stop
    $ghPath = $ghCmd.Source
} catch {
    # Try to find gh.exe in common locations
    $possiblePaths = @(
        "C:\Program Files\GitHub CLI\gh.exe",
        "C:\Program Files\GitHub CLI\bin\gh.exe",
        "$env:USERPROFILE\AppData\Local\Microsoft\WinGet\Links\gh.exe",
        "C:\ProgramData\chocolatey\bin\gh.exe",
        "C:\tools\gh\gh.exe"
    )

    # Also check WinGet packages folder (may have version in path)
    $wingetPackages = "$env:USERPROFILE\AppData\Local\Microsoft\WinGet\Packages"
    if (Test-Path $wingetPackages) {
        $ghDirs = Get-ChildItem -Path $wingetPackages -Directory -Filter "GitHub.cli_*" | Sort-Object Name -Descending
        foreach ($dir in $ghDirs) {
            $candidate = Join-Path $dir.FullName "x64\gh.exe"
            if (Test-Path $candidate) {
                $possiblePaths += $candidate
                break
            }
        }
    }

    foreach ($path in $possiblePaths) {
        if (Test-Path $path) {
            $ghPath = $path
            break
        }
    }

    if (-not $ghPath) {
        Write-Error @"
GitHub CLI (gh) is not found in PATH or common installation locations.

Installation options:
1. Winget: winget install --id GitHub.cli
2. Chocolatey: choco install gh
3. Download: https://cli.github.com/

After installation, ensure it's in your PATH or run this script from the directory containing gh.exe
"@
        exit 1
    }
}

Write-Host "Using GitHub CLI at: $ghPath" -ForegroundColor Cyan

# Check GitHub CLI authentication
$authStatus = & $ghPath auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error @"
GitHub CLI is not authenticated. Run:
  $ghPath auth login
"@
    exit 1
}

# Check if release/tag already exists
$existingRelease = & $ghPath release view "v$Version" --repo $Repo 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Error "Release v$Version already exists. Bump version in package.json first."
    exit 1
}

# Ensure we're on the release branch and clean
$branch = git branch --show-current
if ($branch -ne $Branch) {
    Write-Error "Must be on $Branch branch. Current branch: $branch"
    exit 1
}

$status = git status --porcelain
if ($status) {
    Write-Error "Working directory is not clean. Please commit or stash changes (including the submodule pointer, if nui_wc2 was bumped)."
    exit 1
}

# The tag gh creates points at the remote branch head - refuse to build a
# release from commits that aren't pushed yet.
git fetch origin $Branch --quiet
$local = git rev-parse HEAD
$remote = git rev-parse "origin/$Branch"
if ($local -ne $remote) {
    Write-Error "Local $Branch is not in sync with origin/$Branch. Push first - the release tag would otherwise point at code that differs from the built artifacts."
    exit 1
}

# Optionally clean old builds
if ($Clean) {
    Write-Host "Cleaning old builds..." -ForegroundColor Yellow
    if (Test-Path $OutDir) {
        Remove-Item -Path $OutDir -Recurse -Force
    }
}

# Build the application
Write-Host "Building application..." -ForegroundColor Yellow
npm run make

if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed"
    exit 1
}

# Find generated artifacts
$makeDir = Join-Path $OutDir "make\squirrel.windows\x64"
$installerPath = Get-ChildItem -Path "$makeDir\*.exe" | Where-Object { $_.Name -ne "Update.exe" } | Select-Object -First 1
$nupkgPath = Get-ChildItem -Path "$makeDir\*-full.nupkg" | Select-Object -First 1
$releasesPath = Get-Item -Path "$makeDir\RELEASES"

if (-not $installerPath -or -not $nupkgPath -or -not $releasesPath) {
    Write-Error "Could not find generated artifacts in $makeDir"
    exit 1
}

Write-Host "Found installer: $($installerPath.FullName)" -ForegroundColor Green
Write-Host "Found nupkg: $($nupkgPath.FullName)" -ForegroundColor Green
Write-Host "Found RELEASES: $($releasesPath.FullName)" -ForegroundColor Green

# Create release notes if not provided
if (-not $Notes) {
    Write-Error "Release notes are required. Please provide them using the -Notes parameter."
    exit 1
}

# Create the GitHub release
Write-Host "Creating GitHub release..." -ForegroundColor Yellow

$ghArgs = @(
    "release", "create", "v$Version",
    "--repo", $Repo,
    "--title", "nMarkdownViewer v$Version",
    "--notes", $Notes,
    $installerPath.FullName,
    $nupkgPath.FullName,
    $releasesPath.FullName
)

if ($Draft) {
    $ghArgs += "--draft"
}

& $ghPath @ghArgs

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to create GitHub release"
    exit 1
}

# Fetch the tag that GitHub created so it's in local repo
Write-Host "Syncing release tag to local repo..." -ForegroundColor Yellow
git fetch --tags

Write-Host "Release v$Version created successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "View release at: https://github.com/$Repo/releases/tag/v$Version" -ForegroundColor Cyan
