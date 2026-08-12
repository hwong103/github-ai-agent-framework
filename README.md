# GitHub AI Agent Framework

A shared, provider-agnostic framework for triaging GitHub issues and product
feedback, and for producing tested implementation patches as Draft Pull
Requests. One Cloudflare Worker and one D1 database serve every connected
repository; each project supplies its own deterministic policy, page
allowlist, risk terms, verification commands, and model routes.

The framework never merges. Its terminal output is a Draft Pull Request or a
blocked issue with an audit comment.

## Architecture (v0.2, pursued model)

One shared Worker owns triage for all projects. GitHub webhooks and in-app
feedback submissions both flow into it; a per-repository GitHub Actions
workflow on a shared self-hosted runner does the code work with OpenCode Go
credentials that never leave that runner.

```text
per-project app (in-app feedback dialog, thin)
        | POST /api/feedback with project token
        v
+-----------------------------------------------+
| shared feedback-agent Worker (deployed once)   |
| POST /api/feedback         in-app intake       |
| POST /api/webhooks/github  issue events        |
| queue consumer + cron recovery                |
| D1 cases (project_id + repo)                  |
| R2 screenshots (project/<id>/...)             |
| Workers AI assessment + per-project policy    |
| GitHub App token -> create/update issue       |
+-----------------------------------------------+
        | marker + labels (agent:ready / needs:triage)
        v
per-repo .github/workflows/feedback-agent.yml (label-gated)
        v
shared org-level self-hosted runner (OpenCode Go auth lives only here)
        v
Draft PR in that repo
```

Everything in `worker/` is the shared service. Everything in `reusable/` is
installed into each connected repository (workflow wrapper, runner script,
policy file). `docs/` explains how to provision the shared service and onboard
a new project.

## v0.1 legacy

The earlier GitHub Actions-only mode (triage -> implementation -> publish with
an `agent-approved` label, no Worker) remains available and is documented in
the `agent/` directory. The shared Worker is the model this repository is
moving to; see `docs/architecture.md` for the comparison.

## Quick start

```bash
cd worker
npm ci
npm run dev
```

See `docs/provisioning.md` for the GitHub App, secrets, D1, R2, queue, and
runner setup, and `docs/onboarding-project.md` for connecting a new project.

## License

MIT
