<#
.SYNOPSIS
  Deploy HK Kindergarten Ranking to Google Cloud Run and configure all services.
.DESCRIPTION
  This script:
  1. Authenticates with Google Cloud
  2. Creates a project (or reuses existing)
  3. Enables required APIs
  4. Creates OAuth credentials
  5. Registers a reCAPTCHA site key
  6. Builds and deploys to Cloud Run
  7. Sets all environment variables
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ── Configuration ──────────────────────────────────────────────
$PROJECT_ID   = 'hkkgranking'
$REGION       = 'asia-east1'          # Hong Kong region
$SERVICE_NAME = 'hkkgranking-web'
$APP_DIR      = Split-Path $PSScriptRoot -Parent   # website/

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  HK Kindergarten Ranking - Deployment" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# ── Step 0: Verify gcloud ─────────────────────────────────────
function Ensure-Gcloud {
    $gcloud = Get-Command gcloud -ErrorAction SilentlyContinue
    if (-not $gcloud) {
        # Try common install paths
        $paths = @(
            "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin",
            "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin",
            "$env:ProgramFiles(x86)\Google\Cloud SDK\google-cloud-sdk\bin",
            "C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin"
        )
        foreach ($p in $paths) {
            if (Test-Path "$p\gcloud.cmd") {
                $env:PATH = "$p;$env:PATH"
                Write-Host "Found gcloud at $p" -ForegroundColor Green
                return
            }
        }
        Write-Host "ERROR: gcloud CLI not found. Install from https://cloud.google.com/sdk/install" -ForegroundColor Red
        exit 1
    }
}

Ensure-Gcloud

# ── Step 1: Authenticate ──────────────────────────────────────
Write-Host "[1/8] Authenticating with Google Cloud..." -ForegroundColor Yellow
$account = & gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>$null
if (-not $account) {
    Write-Host "  Opening browser for Google sign-in..." -ForegroundColor Gray
    & gcloud auth login --brief
    $account = & gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>$null
}
Write-Host "  Authenticated as: $account" -ForegroundColor Green

# ── Step 2: Create or select project ─────────────────────────
Write-Host "`n[2/8] Setting up project: $PROJECT_ID" -ForegroundColor Yellow
$existing = & gcloud projects describe $PROJECT_ID --format="value(projectId)" 2>$null
if (-not $existing) {
    Write-Host "  Creating project..." -ForegroundColor Gray
    & gcloud projects create $PROJECT_ID --name="HK KG Ranking" --set-as-default
} else {
    Write-Host "  Project already exists, selecting it..." -ForegroundColor Gray
}
& gcloud config set project $PROJECT_ID 2>$null

# ── Step 3: Enable billing check ─────────────────────────────
Write-Host "`n[3/8] Checking billing..." -ForegroundColor Yellow
$billing = & gcloud billing projects describe $PROJECT_ID --format="value(billingAccountName)" 2>$null
if (-not $billing) {
    Write-Host @"
  ⚠ Billing is NOT enabled on this project.
  Cloud Run requires billing (but has a generous free tier).
  
  Please enable billing at:
  https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID
  
  Then re-run this script.
"@ -ForegroundColor Red
    exit 1
}
Write-Host "  Billing is active." -ForegroundColor Green

# ── Step 4: Enable APIs ──────────────────────────────────────
Write-Host "`n[4/8] Enabling required APIs..." -ForegroundColor Yellow
$apis = @(
    'run.googleapis.com',
    'cloudbuild.googleapis.com',
    'artifactregistry.googleapis.com',
    'recaptchaenterprise.googleapis.com'
)
foreach ($api in $apis) {
    Write-Host "  Enabling $api..." -ForegroundColor Gray
    & gcloud services enable $api --quiet 2>$null
}
Write-Host "  All APIs enabled." -ForegroundColor Green

# ── Step 5: Create OAuth credentials ─────────────────────────
Write-Host "`n[5/8] Setting up OAuth credentials..." -ForegroundColor Yellow

# Configure OAuth consent screen
Write-Host "  Configuring OAuth consent screen..." -ForegroundColor Gray

# Create OAuth client ID
$oauthClients = & gcloud alpha iap oauth-clients list "projects/$PROJECT_ID/brands/-" --format=json 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue

# Use REST API to create OAuth client
$OAUTH_CLIENT_ID = ''
$OAUTH_CLIENT_SECRET = ''

# Check if we already have credentials saved
$envFile = Join-Path $APP_DIR '.env'
$envContent = Get-Content $envFile -Raw -ErrorAction SilentlyContinue
if ($envContent -match 'GOOGLE_CLIENT_ID=(\S+)' -and $Matches[1]) {
    $OAUTH_CLIENT_ID = $Matches[1]
    Write-Host "  Using existing GOOGLE_CLIENT_ID from .env" -ForegroundColor Gray
}

if (-not $OAUTH_CLIENT_ID) {
    Write-Host @"
  
  ┌─────────────────────────────────────────────────────────────┐
  │  OAuth credentials must be created manually (one time):     │
  │                                                              │
  │  1. Go to: https://console.cloud.google.com/apis/credentials│
  │     ?project=$PROJECT_ID                                     │
  │                                                              │
  │  2. Click '+ CREATE CREDENTIALS' > 'OAuth client ID'        │
  │  3. Application type: 'Web application'                      │
  │  4. Name: 'HK KG Ranking'                                   │
  │  5. Authorized redirect URIs: (add after deploy)             │
  │  6. Click 'Create' and copy the Client ID and Secret         │
  └─────────────────────────────────────────────────────────────┘
  
"@ -ForegroundColor Cyan

    $OAUTH_CLIENT_ID = Read-Host "  Enter OAuth Client ID (or press Enter to skip)"
    if ($OAUTH_CLIENT_ID) {
        $OAUTH_CLIENT_SECRET = Read-Host "  Enter OAuth Client Secret"
    }
}

# ── Step 6: Get reCAPTCHA keys ────────────────────────────────
Write-Host "`n[6/8] Setting up reCAPTCHA v2..." -ForegroundColor Yellow

$CAPTCHA_SITE_KEY = ''
$CAPTCHA_SECRET_KEY = ''

if ($envContent -match 'CAPTCHA_SITE_KEY=(\S+)' -and $Matches[1]) {
    $CAPTCHA_SITE_KEY = $Matches[1]
    Write-Host "  Using existing CAPTCHA_SITE_KEY from .env" -ForegroundColor Gray
}

if (-not $CAPTCHA_SITE_KEY) {
    Write-Host @"
  
  ┌─────────────────────────────────────────────────────────────┐
  │  reCAPTCHA v2 keys (free):                                   │
  │                                                              │
  │  1. Go to: https://www.google.com/recaptcha/admin/create     │
  │  2. Label: 'HK KG Ranking'                                  │
  │  3. Type: 'reCAPTCHA v2' > 'I'm not a robot'                │
  │  4. Domains: localhost (add your domain later)               │
  │  5. Accept terms and click 'Submit'                          │
  │  6. Copy Site Key and Secret Key                             │
  └─────────────────────────────────────────────────────────────┘
  
"@ -ForegroundColor Cyan

    $CAPTCHA_SITE_KEY = Read-Host "  Enter reCAPTCHA Site Key (or press Enter to skip)"
    if ($CAPTCHA_SITE_KEY) {
        $CAPTCHA_SECRET_KEY = Read-Host "  Enter reCAPTCHA Secret Key"
    }
}

# ── Step 7: Build & Deploy to Cloud Run ──────────────────────
Write-Host "`n[7/8] Building and deploying to Cloud Run..." -ForegroundColor Yellow
Write-Host "  Region: $REGION" -ForegroundColor Gray
Write-Host "  Service: $SERVICE_NAME" -ForegroundColor Gray
Write-Host "  This may take 3-5 minutes on first deploy..." -ForegroundColor Gray

Push-Location $APP_DIR

# Generate a secure JWT secret for production
$JWT_SECRET = [System.Convert]::ToBase64String((1..48 | ForEach-Object { [byte](Get-Random -Max 256) }))

# Build env vars string for Cloud Run
$envVars = @(
    "PORT=8080",
    "NODE_ENV=production",
    "JWT_SECRET=$JWT_SECRET",
    "DATABASE_URL=file:./prisma/dev.db",
    "EMAIL_OTP_SECRET=$([System.Convert]::ToBase64String((1..32 | ForEach-Object { [byte](Get-Random -Max 256) })))",
    "CAPTCHA_PROVIDER=recaptcha",
    "REQUIRE_EMAIL_VERIFIED=false",
    "REVIEW_RATE_LIMIT_WINDOW_MS=900000",
    "REVIEW_RATE_LIMIT_MAX=5"
)

if ($OAUTH_CLIENT_ID) {
    $envVars += "GOOGLE_CLIENT_ID=$OAUTH_CLIENT_ID"
    $envVars += "GOOGLE_CLIENT_SECRET=$OAUTH_CLIENT_SECRET"
}
if ($CAPTCHA_SITE_KEY) {
    $envVars += "CAPTCHA_SITE_KEY=$CAPTCHA_SITE_KEY"
    $envVars += "CAPTCHA_SECRET_KEY=$CAPTCHA_SECRET_KEY"
}

$envVarString = $envVars -join ','

# Deploy from source (Cloud Build will use the Dockerfile)
& gcloud run deploy $SERVICE_NAME `
    --source . `
    --region $REGION `
    --allow-unauthenticated `
    --memory 512Mi `
    --cpu 1 `
    --min-instances 0 `
    --max-instances 2 `
    --set-env-vars "$envVarString" `
    --quiet

Pop-Location

# ── Step 8: Get URL and configure OAuth redirect ─────────────
Write-Host "`n[8/8] Finalizing..." -ForegroundColor Yellow
$SERVICE_URL = & gcloud run services describe $SERVICE_NAME --region $REGION --format="value(status.url)" 2>$null

if ($SERVICE_URL) {
    Write-Host "`n========================================" -ForegroundColor Green
    Write-Host "  DEPLOYMENT SUCCESSFUL!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "`n  Live URL: $SERVICE_URL" -ForegroundColor Cyan
    
    # Update BASE_URL and FRONTEND_URL
    & gcloud run services update $SERVICE_NAME `
        --region $REGION `
        --update-env-vars "BASE_URL=$SERVICE_URL,FRONTEND_URL=$SERVICE_URL" `
        --quiet 2>$null

    Write-Host @"

  ┌─────────────────────────────────────────────────────────────┐
  │  IMPORTANT: Update OAuth redirect URI                       │
  │                                                              │
  │  Go to: https://console.cloud.google.com/apis/credentials   │
  │  Edit your OAuth client and add this redirect URI:           │
  │                                                              │
  │  ${SERVICE_URL}/api/auth/google/callback                     │
  │                                                              │
  │  Also add your domain to reCAPTCHA allowed domains:          │
  │  https://www.google.com/recaptcha/admin                      │
  └─────────────────────────────────────────────────────────────┘

"@ -ForegroundColor Yellow

    # Test the deployment
    Write-Host "  Testing health endpoint..." -ForegroundColor Gray
    try {
        $health = Invoke-RestMethod "$SERVICE_URL/health"
        Write-Host "  Health check: OK ($($health.ok))" -ForegroundColor Green
    } catch {
        Write-Host "  Health check failed - service may still be starting up" -ForegroundColor Yellow
    }

    Write-Host "`n  Your site is live at: $SERVICE_URL" -ForegroundColor Green
} else {
    Write-Host "`n  Deployment may have failed. Check:" -ForegroundColor Red
    Write-Host "  gcloud run services list --region $REGION" -ForegroundColor Gray
}
