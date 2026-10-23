# Source control and recovery

The Git backup preserves both the published application and the complete current working code.

- `main` contains the verified production source and recovery documentation.
- `production/2026-10-22` and the `production-2026-10-22` tag preserve the exact 650-file source snapshot deployed as `dpl_6RfQfcdGmguUDeHd3XMVtKxCCo2s`.
- `codex/avenue-z-analytics` preserves every versionable file from the working checkout, including unpublished work. Nothing is discarded to produce the production snapshot.

The production manifest SHA256 is `630664084c4bde9a88dfad12180798aec55e7e2a1f9c5b6d08abb6cd601f30cc`. The production source passed 3,380 tests, native TypeScript and the native Next.js webpack build on October 23, 2026. The release manifest is retained under `docs/releases/production-2026-10-22-files.json` on `main`.

The working branch also preserves two known portfolio integration issues: the dashboard does not pass the required `ExecutiveOverview.mutate` property, and `portfolioRequestParams` is not exported. Its verification run had 3,441 passing tests and two failures. This branch is a complete backup of work in progress; it is not the source currently deployed to Vercel.

## Recover the application

Clone the private repository, select the desired branch or release tag, install dependencies with `npm ci`, and use `npm run build:vercel` for the native Vercel build. Run `npm test` for the test suite. Supported Node versions are declared in `package.json`.

Configure server-side credentials using `config/vercel.env.example` and the provider documentation. Database schema changes are versioned under `drizzle/` and applied with `npm run db:migrate:vercel`. Restore the existing production configuration and data using the hosting/database providers; a source checkout does not contain the live database.

Vercel owns the production schedules in `vercel.json`. No laptop or Codex scheduled task is needed. The GitHub workflow is a disabled-by-default manual operational check. Backing up Git does not change the live deployment or enable another refresh scheduler.

## Deliberately outside Git

Live credentials, environment files, OAuth grants, client/customer records, database contents, private exports and local operational captures remain outside the repository. Runtime data belongs in the hosted database and credentials belong in the provider secret stores. `.gitignore` excludes local private runtime files, build output and dependency installations.

Commit subsequent source changes and push their branch before reporting that GitHub is synchronized. Verify the remote commit or tree after pushing; a successful Vercel deployment alone does not establish a GitHub backup.
