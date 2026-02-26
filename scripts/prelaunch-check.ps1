$ErrorActionPreference = 'Stop'

$envFile = Join-Path $PSScriptRoot '..\.env'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $idx = $line.IndexOf('=')
    if ($idx -lt 1) { return }
    $name = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim().Trim('"')
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      [Environment]::SetEnvironmentVariable($name, $value)
    }
  }
}

function Pass($msg) { Write-Host "PASS: $msg" -ForegroundColor Green }
function WarnItem($msg) { Write-Host "WARN: $msg" -ForegroundColor Yellow }
function FailItem($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red }

$failCount = 0
$warnCount = 0

function Require-Env([string]$name) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    FailItem "Missing env var: $name"
    $script:failCount++
  } else {
    Pass "Env var set: $name"
  }
}

Write-Host "=== Prelaunch Check ===" -ForegroundColor Cyan

# 1) Required environment variables
$requiredEnv = @(
  'BASE_URL',
  'FRONTEND_URL',
  'JWT_SECRET',
  'DATABASE_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_MAPS_API_KEY',
  'CAPTCHA_PROVIDER',
  'CAPTCHA_SITE_KEY',
  'CAPTCHA_SECRET_KEY',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'EMAIL_OTP_SECRET'
)

foreach ($name in $requiredEnv) {
  Require-Env $name
}

$requireVerified = [Environment]::GetEnvironmentVariable('REQUIRE_EMAIL_VERIFIED')
if ($requireVerified -ne 'true') {
  WarnItem 'REQUIRE_EMAIL_VERIFIED is not true (recommended for production).'
  $warnCount++
} else {
  Pass 'REQUIRE_EMAIL_VERIFIED=true'
}

# 2) Local runtime health check
try {
  $health = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3001/health' -TimeoutSec 5
  if ($health.StatusCode -eq 200) {
    Pass '/health returns 200 on localhost:3001'
  } else {
    FailItem "/health returned status $($health.StatusCode)"
    $failCount++
  }
} catch {
  WarnItem 'Local server not reachable on localhost:3001 (start server before local smoke test).'
  $warnCount++
}

# 3) API structure check
try {
  $schools = Invoke-RestMethod -Uri 'http://localhost:3001/api/kindergartens' -Method Get -TimeoutSec 8
  if ($schools.Count -gt 0) {
    Pass "Kindergarten API returns $($schools.Count) records"
    $sample = $schools[0]

    $neededFields = @('googleReviewScore', 'googleFormattedAddress', 'weightedScore')
    foreach ($f in $neededFields) {
      if ($sample.PSObject.Properties.Name -contains $f) {
        Pass "API field exists: $f"
      } else {
        FailItem "API field missing: $f"
        $failCount++
      }
    }

    $nonNullGoogle = @($schools | Where-Object { $null -ne $_.googleReviewScore -or $null -ne $_.googleFormattedAddress }).Count
    if ($nonNullGoogle -gt 0) {
      Pass "Google data populated for $nonNullGoogle schools"
    } else {
      WarnItem 'No schools currently have Google rating/address. Run: npm run sync:google-ratings'
      $warnCount++
    }
  } else {
    FailItem 'Kindergarten API returned 0 records'
    $failCount++
  }
} catch {
  WarnItem 'Could not query kindergarten API (server may be offline locally).'
  $warnCount++
}

# 4) CAPTCHA config endpoint check
try {
  $captcha = Invoke-RestMethod -Uri 'http://localhost:3001/api/auth/captcha-config' -Method Get -TimeoutSec 5
  if ($captcha.provider -eq 'recaptcha') {
    Pass 'CAPTCHA provider is recaptcha'
  } else {
    WarnItem "CAPTCHA provider is '$($captcha.provider)' (expected recaptcha)"
    $warnCount++
  }

  if ($captcha.enabled -eq $true) {
    Pass 'CAPTCHA site key is enabled'
  } else {
    FailItem 'CAPTCHA site key is not enabled'
    $failCount++
  }
} catch {
  WarnItem 'Could not read /api/auth/captcha-config (server may be offline locally).'
  $warnCount++
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "Fails: $failCount" -ForegroundColor Red
Write-Host "Warnings: $warnCount" -ForegroundColor Yellow

if ($failCount -gt 0) {
  exit 1
}

exit 0
