# Connecting a new project

Each project keeps a thin in-app feedback dialog plus a small GitHub-side
install; everything else lives in the shared Worker.

## GitHub-side install (every project)

1. Copy `reusable/workflows/feedback-agent.yml` to
   `.github/workflows/feedback-agent.yml`, pinning the framework release ref
   used to fetch the runner script.
2. Copy `reusable/scripts/feedback-agent-run.ps1` to `scripts/` and
   `reusable/feedback-agent-policy.example.yml` to
   `.github/feedback-agent-policy.yml`.
3. Create labels: `feedback`, `bug`, `enhancement`, `needs:triage`,
   `agent:ready`, `agent:blocked`, `agent:pr-open`,
   `agent:model:kimi-k3`, `agent:model:deepseek-v4-flash`.
4. Protect the default branch: require PR review and required checks; never
   let a draft PR deploy or auto-merge.
5. Install the GitHub App on the repository.

## Shared Worker config (one entry per project)

Add a validated entry to `PROJECTS_JSON`:

```json
{
  "my-app": {
    "projectId": "my-app",
    "repo": "owner/my-app",
    "defaultBranch": "main",
    "productName": "My App",
    "policyVersion": "2026-08-12.1",
    "assessmentModel": "@cf/meta/llama-4-scout-17b-16e-instruct",
    "staticPaths": ["/", "/profile"],
    "dynamicPathPatterns": [],
    "riskTerms": ["balance", "settlement", "payment", "migration", "delete"],
    "microfixTerms": ["typo", "tooltip", "copy", "text"],
    "uiLocationTerms": ["button", "page", "profile"],
    "token": "per-project-shared-secret"
  }
}
```

Keep `policyVersion` identical to `.github/feedback-agent-policy.yml` in the
connected repository. Keep the per-project `token` in the Worker secret and in
the app's server-side call, never in client code.

## In-app feedback (optional, per project)

The app sends a multipart POST to
`https://<worker>.workers.dev/api/feedback` with:

- Header `x-project-id: <project_id>`
- Header `Authorization: Bearer <per-project-token>`
- Header `x-user-key: <server-side user id>`
- Form fields `message`, `pathname`, `clientRequestId`, optional `screenshot`

The app is responsible for its own session check before calling the Worker.

## GitHub-issue-only usage

If a project does not need in-app capture, the GitHub webhook path covers it:
an issue opened with `agent:ready` (or labeled later) is triaged, assessed,
and updated in place with the digest marker. The webhook verifies the HMAC
signature before doing any work.

## Rehearsal checklist

1. Submit a narrow UI microfix; confirm `agent:ready` issue + draft PR.
2. Submit a screenshot report; confirm assessment ran and R2 object deleted.
3. Submit an ambiguous or high-risk report; confirm `needs:triage`, no run.
4. Reapply `agent:ready` to a stale issue; confirm it returns to
   `needs:triage` with an audit comment.
5. Re-triage an existing issue; confirm the marker and labels refresh in place
   without a second issue.
