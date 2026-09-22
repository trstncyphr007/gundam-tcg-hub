# ADR-032: Provenance for every image, verified where it is used

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** SR-0.x supply chain, §18.4, §15.5, ASVS 17.3; amends ADR-014

## Context

ASVS 17.3 was Partial because GitHub's build-provenance store rejects user-owned _private_
repositories (ADR-014). The repository has been public for a while, and `release.yml` already
turned the step on for public repos. So the item looked done apart from paperwork.

Checking it turned up four things instead:

1. **Only `gth-api` was ever attested.** The provenance step named one subject, so the web
   image, which is the one that serves every page, never had provenance.
2. **Nothing verified any attestation.** The release created one and moved on, and the
   deploy gate checked cosign signatures only.
3. **The image packages are private.** An anonymous manifest read returns 403, while
   `deploy.yml` ran `cosign verify` against GHCR with no login and no `packages`
   permission. The first deploy would have failed at its first step. Nobody noticed because
   no VPS exists yet. The server has the same problem when it pulls and re-verifies.
4. **A release had already failed on a transient error.** Run 35680553653 lost cosign's GitHub
   OIDC token fetch (`reading ID token: invalid character 'u'`). Nothing retried it.

On the way I briefly suspected a fifth: the attestation seemed to name a digest the registry
didn't know. It didn't. The second digest in the log is the attestation's _own_ artifact,
which `push-to-registry` stores beside the image, and "manifest unknown" was the registry
declining an unauthenticated read of a private package.

## Decision

- **Both images get SLSA v1 provenance.** There's one attestation step per image.
- **The release verifies what it just attested.** `gh attestation verify`, with the signer
  pinned to this repository's `release.yml`, fails the release if either image's provenance
  doesn't verify. That happens before anyone can copy its digests into a deploy.
- **The deploy gate verifies provenance as well as signatures:** built by `release.yml`, from
  `refs/heads/main`, in this repository. A signature says "we signed this"; provenance says
  "and it was built from this commit by this workflow". The deploy needs both.
- **The deploy workflow can read the images.** It gets `packages: read` and
  `attestations: read`, and logs in to GHCR with its own short-lived job token.
- **Signing retries.** `cosign sign` and `cosign attest` get three attempts with a pause.
  Signing twice only adds a second signature, so a retry is safe.

The **server's** access to private images is left as a decision (runbook `deploy.md`).

- **Recommended: make both packages public.** The source is already public, the images hold
  no secrets, and the server then needs no credential at all.
- **The alternative:** a fine-grained `read:packages` token in SOPS, with a `docker login`
  in `deploy.sh`, added to the rotation inventory.

It changes a published asset's visibility, so it isn't mine to flip.

**Decided 2026-09-23: public.** The owner chose the recommended option. `preflight.sh` checks
that both packages are anonymously readable, so a package that goes private again is caught
before a deploy rather than during one.

## Consequences

- ASVS 17.3 is **Met**, with that one open decision recorded against it.
- **The new release steps can't run from a branch.** Dispatching `release.yml` from one would
  push branch-built images into the production registry. Their first real run is the release
  after merge, which is watched before this is called done. actionlint and zizmor pass on
  both workflows.
