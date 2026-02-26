# Launch Checklist (HK Kindergarten Ranking)

Use this checklist before going live.

## 1) Domain & Hosting
- [ ] Register domain (e.g. hkkgranking.com)
- [ ] Deploy app to production host with HTTPS
- [ ] Configure DNS (`A`/`CNAME`) to hosting target
- [ ] Confirm site loads from your real domain

## 2) Environment Variables
Set production env vars (not `.env` in source control):
- [ ] `PORT`
- [ ] `BASE_URL` (e.g. `https://hkkgranking.com`)
- [ ] `FRONTEND_URL` (e.g. `https://hkkgranking.com`)
- [ ] `JWT_SECRET` (strong random string)
- [ ] `DATABASE_URL`
- [ ] `GOOGLE_CLIENT_ID`
- [ ] `GOOGLE_CLIENT_SECRET`
- [ ] `GOOGLE_MAPS_API_KEY`
- [ ] `CAPTCHA_PROVIDER` (`recaptcha`)
- [ ] `CAPTCHA_SITE_KEY`
- [ ] `CAPTCHA_SECRET_KEY`
- [ ] `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- [ ] `EMAIL_OTP_SECRET`
- [ ] `REQUIRE_EMAIL_VERIFIED=true`

## 3) Google Cloud Setup
- [ ] OAuth consent screen configured
- [ ] OAuth redirect URI includes `/api/auth/google/callback`
- [ ] Places API enabled + billing enabled
- [ ] `GOOGLE_MAPS_API_KEY` restricted (APIs + referrer/IP)

## 4) Database & Data
- [ ] `npm run prisma:push`
- [ ] `npm run import:gov:kgp` (if needed)
- [ ] `npm run sync:google-ratings`
- [ ] Verify non-null `googleReviewScore` / `googleFormattedAddress`

## 5) Ads & Policy
- [ ] Replace AdSense placeholders with real publisher + slot IDs
- [ ] Add Privacy Policy page
- [ ] Add Terms page
- [ ] Add Contact page

## 6) Functional Smoke Tests
- [ ] `/health` returns 200
- [ ] Home loads and rankings display
- [ ] Area drilldown and school profile pages work
- [ ] Google login works
- [ ] Email verification works (send code + verify)
- [ ] CAPTCHA challenge appears and validates
- [ ] Review submission works and one-review rule enforced

## 7) Run Automated Prelaunch Check
- [ ] `npm run prelaunch:check`
- [ ] Resolve any `FAIL` items before launch
