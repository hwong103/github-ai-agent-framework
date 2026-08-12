# Repository instructions

## Architecture

The shared Worker is the pursued model: one Worker, one D1 database, many
connected projects. Keep model-facing analysis, deterministic validation, and
credentialed GitHub writes in separate modules inside `worker/src/`. Keep
provider-specific behavior in `worker/src/feedback/assessment.ts` and the
provider interface. Keep GitHub write operations in
`worker/src/feedback/github.ts`, which only ever uses GitHub App installation
tokens.

The `agent/` directory is the v0.1 GitHub Actions-only mode and is legacy;
do not add new features there without an explicit reason.

## Conventions

- TypeScript is strict ESM. Worker code targets the Workers runtime
  (`nodejs_compat`); tests run with `node --experimental-strip-types`.
- Validate all untrusted JSON, YAML, model output, event payloads, and
  screenshot bytes with explicit schemas or magic-byte checks.
- Avoid `any`, double casts, shell execution, and module-level mutable state.
- Dependencies are injected at external boundaries so tests can use fakes.
- Every project's deterministic policy is validated before use; project
  configuration is never treated as executable code.

## Commands

- Worker install: `cd worker && npm ci`
- Dev: `cd worker && npm run dev`
- Typecheck: `cd worker && npm run typecheck`
- Test: `cd worker && npm test`
- Full check: `cd worker && npm run check`

## Prohibited changes

- Never add automatic merge behavior.
- Never pass a GitHub write token or provider credential into a model or
  repository-command process.
- Never replace exact command allow-lists with arbitrary shell execution.
- Never weaken protected-path, patch-limit, marker-digest, or stale-approval
  validation for convenience.
- Never embed a desktop OpenCode Go subscription credential in the Worker.

## Deployment

Tag stable releases and reference immutable tags or SHAs from installed
workflows. The Worker is deployed with Wrangler; secrets are set with
`wrangler secret put`.
