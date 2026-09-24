# Launch Checklist (HK Kindergarten Ranking)

Use this checklist before going live.

## 1) Domain & Hosting
- [ ] Register domain (e.g. hkkgranking.com)
- [ ] Deploy app to production host with HTTPS
- [ ] Use a persistent PostgreSQL database (SQLite inside a container loses reviews on every redeploy/restart — see README)
- [ ] Configure DNS (`A`/`CNAME`) to hosting target
- [ ] Confirm site loads from your real domain

## 2) Environment Variables
Set production env vars (not `.env` in source control):
- [ ] `NODE_ENV=production`
- [ ] `PORT`
- [ ] `BASE_URL` (e.g. `https://hkkgranking.com`)
- [ ] `FRONTEND_URL` (e.g. `https://hkkgranking.com`)
- [ ] `JWT_SECRET` (strong random string; the server will not start without it)
- [ ] `DATABASE_URL`
- [ ] `TRUST_PROXY` (number of proxies in front of the app; `1` on Render and Cloud Run)
- [ ] `GOOGLE_CLIENT_ID`
- [ ] `GOOGLE_CLIENT_SECRET`
- [ ] `GOOGLE_MAPS_API_KEY`
- [ ] `CAPTCHA_PROVIDER` (`recaptcha`)
- [ ] `CAPTCHA_SITE_KEY`
- [ ] `CAPTCHA_SECRET_KEY`
- [ ] `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (only needed for accounts whose email Google has not verified)
- [ ] `EMAIL_OTP_SECRET`
- [ ] `REQUIRE_EMAIL_VERIFIED=true`

## 3) Google Cloud Setup
- [ ] OAuth consent screen configured
- [ ] OAuth redirect URI includes `/api/auth/google/callback`
- [ ] Places API (New) enabled + billing enabled (the legacy Places API is not available to new projects)
- [ ] `GOOGLE_MAPS_API_KEY` restricted to Places API (New); it is used server-side, so restrict by IP rather than HTTP referrer
- [ ] Check the Google Maps Platform terms for storing and displaying Places ratings

## 4) Database & Data
- [ ] `npm run prisma:push`
- [ ] `npm run import:gov:kgp` (if needed; safe to re-run)
- [ ] `npm run sync:google-ratings -- --dry-run --limit=20` and check the matches
- [ ] `npm run sync:google-ratings`
- [ ] Verify non-null `googleReviewScore` / `googleFormattedAddress`

## 5) Ads & Policy
- [ ] Replace AdSense placeholders (`adConfig` in `public/index.html`) with real publisher + slot IDs
- [ ] Add `<meta name="google-adsense-account" content="ca-pub-...">` for AdSense site verification, and `ads.txt`
- [ ] Add Privacy Policy page (Google sign-in, stored emails and ratings, ad cookies; HK PDPO)
- [ ] Add Terms page
- [ ] Add Contact page

## 6) Functional Smoke Tests
- [ ] `/health` returns 200
- [ ] Home loads and rankings display (5 schools per district)
- [ ] Search, district page and school profile pages work, on a phone too
- [ ] Google login works and returns to the page you started from
- [ ] Email verification works (send code + verify) for an account Google has not verified
- [ ] CAPTCHA challenge appears and validates
- [ ] Rating submission works; rating again updates the same rating
- [ ] `/api/kindergartens` contains no reviewer names or emails

## 7) Run Automated Checks
- [ ] `npm test`
- [ ] `npm run prelaunch:check`
- [ ] Resolve any `FAIL` items before launch
