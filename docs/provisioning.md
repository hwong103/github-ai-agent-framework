# Provisioning the shared Worker

## 1. GitHub App

Create a GitHub App (or use a single app for all connected repos):

- Repository permissions: Issues read/write, Metadata read. No Contents,
  Actions, or administration write access.
- Subscribe to the `Issues` webhook event.
- Set the webhook URL to
  `https://<worker>.workers.dev/api/webhooks/github` and a strong secret.
- Generate a private key (PKCS8 PEM) and note the App ID.
- Install the app on every repository you want to connect.

## 2. Cloudflare resources

```bash
cd worker
npx wrangler d1 create github-ai-agent-framework
npx wrangler r2 bucket create github-ai-agent-framework-feedback
npx wrangler queues create github-ai-agent-framework-feedback
```

Copy the D1 database ID into `wrangler.jsonc`. Apply the migration:

```bash
npx wrangler d1 migrations apply github-ai-agent-framework --remote
```

## 3. Secrets

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put PROJECTS_JSON
```

`PROJECTS_JSON` is a JSON object keyed by `project_id`; each value must match
`ProjectConfigSchema` in `worker/src/config.ts` and include a `token` used by
in-app intake. `GITHUB_APP_ID` and `FEEDBACK_QUEUE_NAME` are plain vars already
in `wrangler.jsonc`.

## 4. Deploy

```bash
cd worker
npm ci
npm run check
npm run deploy
```

Verify `GET /health` returns `{"ok":true}`.

## 5. Shared runner

1. Provision a dedicated, disposable VM or tightly isolated account with no
   production secrets or personal files.
2. Install Git, GitHub CLI, Docker, and the OpenCode CLI. Pre-pull and approve
   `node:20-bookworm`.
3. Sign in to OpenCode Go under the runner account; verify with
   `opencode models opencode-go`.
4. Register a repository-scoped, ephemeral runner with labels
   `feedback-agent` and `ephemeral`.
5. Restrict host outbound traffic to GitHub and the OpenCode provider.

## 6. Labels and connected-repo setup

For each connected repository, follow `docs/onboarding-project.md`: install the
workflow, runner script, and policy file; create labels; confirm
`opencode run --model opencode-go/glm-5.2 "Reply with ok"`; then rehearse the
full loop.
