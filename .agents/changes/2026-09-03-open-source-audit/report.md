---
datetime: 2026-09-03T00:00:00Z
author: Open-source readiness audit
tags: [audit, open-source, security, documentation]
---

# Open-Source Readiness Audit

## Purpose

This report records the publication controls for Sandbox. It does not include private repository history, credentials, personal data, or private infrastructure details.

## Publication Decision

Publish only the reviewed export in the new GitHub repository. Do not publish the former Git object database or ignored local files.

## Required Controls

### Repository

- Create a new Git repository from the reviewed working tree.
- Use `main` as the only initial branch.
- Do not transfer old commits, tags, branches, hooks, bundles, or remotes.
- Run a secret scan against the new repository before it becomes public.

### Distribution

- Use `@maibornwolff/sandbox` as the npm package name.
- Use the public npm registry.
- Use `https://github.com/MaibornWolff/sandbox` for public project links.
- Keep npm publishing disabled until the release workflow receives separate approval.

### Product Defaults

- Keep generated configuration useful without private services.
- Do not enable company-specific domains or credentials by default.
- Keep credential mounts explicit and document their security effect.
- Include only tools that public users can install from public sources.

### Documentation and Media

- Give installation instructions that work without private network access.
- Use public links in all user documentation.
- Use neutral architecture labels.
- Confirm the ownership and release rights for media before publication.

### Automation and Governance

- Run validation for pull requests and pushes to `main`.
- Run end-to-end tests on a real container runtime.
- Generate license notices and a Software Bill of Materials (SBOM).
- Run CodeQL analysis.
- Keep release and package publishing jobs disabled.
- Define contribution, conduct, support, ownership, and security policies.

### Legal

- Release the project under the BSD 3-Clause License.
- Keep the approved copyright attribution.
- Confirm that dependencies and media can be distributed under their applicable licenses.

## Publication Gate

Before the repository becomes public, verify these results:

- A secret scan has no unresolved finding.
- A text search has no private host, package, service, or access instruction.
- `bun check` passes.
- End-to-end tests pass on Docker or Podman.
- The npm package metadata points to the public project.
- Installation and update commands use `@maibornwolff/sandbox`.
- GitHub Actions completes without private credentials or runners.
- GitHub private vulnerability reporting is enabled.
- Branch protection requires the approved validation checks.
- Legal and security owners approve publication.

## Scope Limits

This audit is a technical review of the exported repository. It is not a legal review. Repository settings, npm ownership, media rights, and organization policy need separate owner approval.
