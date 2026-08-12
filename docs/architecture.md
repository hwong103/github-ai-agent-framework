# Architecture: one shared Worker, one D1

## Why one Worker

Every connected project shares the same triage brain: intake validation,
assessment, deterministic policy, GitHub issue creation, screenshot lifecycle,
queueing, and recovery. Deploying one Worker with one D1 database means one AI
binding, one set of secrets, one observability surface, and one upgrade path
for every project.

## Boundaries

```text
in-app feedback POST /api/feedback  (per-project token + user key)
GitHub issue webhook /api/webhooks/github (HMAC-verified)
        |
        v
feedback_cases (D1, project_id on every row)
        |
        v
Workers AI assessment -> deterministic per-project policy
        |
        v
GitHub App installation token -> create/update issue with digest marker
        |
        v
per-repo workflow (agent:ready label gate) -> shared self-hosted runner
        |
        v
Draft PR (never merged automatically)
```

The Worker never holds coding-provider credentials. OpenCode Go (or any other
provider) is consumed by the OpenCode CLI on a dedicated self-hosted runner;
the runner never receives a Worker credential, and the Worker never receives a
runner credential.

## Isolation model

- `project_id` on every row of `feedback_cases`.
- R2 keys namespaced `project/<project_id>/...`.
- Per-project token required on in-app intake (`Authorization: Bearer` plus
  `x-project-id`).
- Per-project deterministic policy: risk terms, page allowlist, microfix
  terms, UI location terms, model routes, and policy version all come from
  `PROJECTS_JSON` (schema-validated).
- GitHub App installation tokens are scoped per repository and minted per
  request.

## Where the per-project policy file fits

The Worker's `PROJECTS_JSON` entry drives intake triage and the issue marker's
`policyVersion`. The repository's own `.github/feedback-agent-policy.yml`
(`reusable/feedback-agent-policy.example.yml`) drives the runner's execution
gates: verification commands, forbidden paths, diff limits, model allowlist,
and stale-approval age. The two must agree on `policy_version`; the runner
fails closed if they drift.
