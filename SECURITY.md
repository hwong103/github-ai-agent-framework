# Security policy and threat model

## Trust boundaries

Issue text, repository content, model responses, implementation artifacts,
target test output, and screenshots are untrusted. Workflow code pinned from
this framework, repository configuration validated on the recorded base
commit, GitHub Actions, the shared Worker's deterministic validators, and the
marker/digest contract form the trusted control plane.

## Shared Worker boundaries

- The Worker holds only a GitHub App private key, a webhook secret, project
  tokens, and per-project configuration. It never holds OpenCode Go or other
  coding-provider credentials.
- Every project is isolated by a `project_id` on every row, an R2 prefix, and a
  per-project token checked on in-app intake.
- Screenshots are stored in R2 under `project/<project_id>/`, are never exposed
  publicly, and are deleted after assessment or when attempts are exhausted.
- The GitHub App token is the only credential with write scope (issues only,
  per-repository installation); it is minted per request and never logged.
- Webhook events are authenticated with `X-Hub-Signature-256` before any work.

## Credential isolation on the runner

- Model jobs do not receive GitHub write permissions.
- Checkout credentials are not persisted in model-facing jobs.
- Controlled target commands receive a minimal environment that omits provider
  keys, GitHub tokens, Actions runtime tokens, passwords, and credentials.
- The write-capable publisher never invokes a model or target command.
- OpenCode Go credentials exist only on the dedicated self-hosted runner.

## Prompt injection

Prompts classify issue, feedback, screenshot, and repository text as untrusted
data. Prompt wording is never a security boundary: deterministic controls
(fixed decision vocabularies, schemas, path rules, exact commands, patch
limits, digest checks, approval-age checks, and GitHub permission separation)
enforce the boundary.

## Patch publication

The runner checks the repository and issue, the trusted `agent:ready` label
and policy version, the marker digest against the immutable GitHub event
snapshot, approval age, forbidden paths, patch size, secret scan, and the
fixed lint/test/build commands before opening a Draft PR. It never force-pushes
and has no merge step.

## Residual risks

- A compromised pinned framework ref or GitHub Action dependency can compromise
  its workflow; release refs and Actions are pinned.
- Model-generated code can still contain subtle defects; required tests and
  Draft PRs reduce but do not replace human review.
- A shared Worker is a shared trust boundary: one misconfiguration can affect
  every connected project, so per-project config is schema-validated and
  deployment changes are reviewed.

## Reporting vulnerabilities

Open a private GitHub security advisory for this repository. Do not include
live tokens, private repository content, or exploitable target details in a
public issue.
