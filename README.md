# HK Kindergarten Ranking 香港幼稚園排名

Ranks Hong Kong kindergartens in each of the 18 districts using parent ratings on the site plus
Google ratings. Parents sign in with Google to rate a school (one rating per school, which they can
change later). The site is bilingual (Traditional Chinese / English).

- **Backend:** Node.js, Express, Prisma (SQLite locally, PostgreSQL in production)
- **Frontend:** a single static page, `public/index.html`
- **Data:** school list scraped from the EDB Kindergarten Profile (KGP) listing; Google ratings from the Places API (New)

## Run locally

```bash
npm ci
cp .env.example .env          # fill in what you need; everything is optional locally
npm run prisma:push           # creates prisma/dev.db
npm run dev                   # http://localhost:3001 — imports the EDB list on first start
```

Without Google OAuth settings the site works read-only. Without `CAPTCHA_SECRET_KEY` and SMTP,
development mode skips the CAPTCHA and shows email codes on screen.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the server with ts-node |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm test` | Unit and API tests (each file uses its own temporary SQLite database) |
| `npm run import:gov:kgp` | Add new schools and refresh names/types from EDB. Safe to re-run: never deletes schools, reviews or Google ratings |
| `npm run sync:google-ratings` | Fetch Google ratings (add `-- --dry-run` to preview matches, `-- --limit=20` to try a few) |
| `npm run prelaunch:check` | Windows prelaunch checks (PowerShell) |

## How the ranking works

Each school's score is a Bayesian average of all its ratings: parent ratings on this site (each
counts as 3 Google ratings) and its Google rating, starting from 10 pseudo-ratings of 3.5. Schools
with few ratings therefore sit near 3.5 until they earn more, so one 5-star rating can't put a
school on top and one hostile rating can't sink it. Schools with no ratings are listed last. See
`src/services/ranking.ts` (`RANKING_PARAMS`).

Duplicate EDB listings of the same school (same name, campus and district) are shown once, with
their ratings combined. Reviewer names, emails and comments are never exposed by the API.

## Deploying

Reviews are the site's most valuable data, so production needs a database that survives restarts:

- **Render (recommended):** `render.yaml` creates a web service plus PostgreSQL. `render-build.js`
  switches the schema to PostgreSQL, creates tables, and imports the school list on first deploy.
- **Docker / Cloud Run:** the image defaults to SQLite inside the container, which loses new reviews
  whenever the container is replaced (every deploy, restart or scale-to-zero).
  `scripts/deploy-gcloud.ps1` therefore limits Cloud Run to one instance. To keep data, build with
  `--build-arg DB_PROVIDER=postgresql` and set `DATABASE_URL` to a PostgreSQL database.

Production requires `NODE_ENV=production` and `JWT_SECRET` (the server refuses to start without it),
plus the Google OAuth, CAPTCHA and (optionally) SMTP settings from `.env.example`. Schema changes that
would delete data make the deploy stop instead of dropping it. See `LAUNCH_CHECKLIST.md`.

To switch a checkout to PostgreSQL by hand: `node scripts/set-db-provider.js postgresql && npm run build`.
