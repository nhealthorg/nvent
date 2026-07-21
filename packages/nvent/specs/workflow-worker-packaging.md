# Workflow Worker Packaging

This document describes the initial implementation for packaging the Rust workflow worker as npm-installable artifacts.

## Package Layout

- `@nvent-addon/workflow-worker` (meta resolver package)
- `@nvent-addon/workflow-worker-linux-x64-gnu`
- `@nvent-addon/workflow-worker-linux-arm64-gnu`
- `@nvent-addon/workflow-worker-darwin-x64`
- `@nvent-addon/workflow-worker-darwin-arm64`
- `@nvent-addon/workflow-worker-win32-x64-msvc`

## Local Build Flow

1. Build and stage binary into the platform package directory:

```bash
pnpm run build:worker:package -- --target linux-x64-gnu
```

2. Pack the platform package:

```bash
pnpm -C packages/workflow-worker-linux-x64-gnu pack
```

3. Pack the meta package:

```bash
pnpm -C packages/workflow-worker-meta pack
```

## Scripts

- `scripts/workflow-worker-targets.mjs`: target mapping and detection
- `scripts/build-workflow-worker-package.mjs`: cargo build + binary copy
- `scripts/verify-workflow-worker-package.mjs`: prepack binary validation

## Runtime Resolution

The meta package resolves the binary path in this order:

1. `NVENT_WORKFLOW_WORKER_BIN`
2. platform optional dependency package (`@nvent-addon/workflow-worker-...`)
3. throw a descriptive error

## CI Pipeline

Workflow: `.github/workflows/workflow-worker-packages.yml`

- builds per target on a matrix
- runs binary staging via `build:worker:package`
- runs `npm pack` for platform package + meta package
- uploads `.tgz` artifacts

Release workflow integration: `.github/workflows/release.yml`

- resolves version once (`workflow_dispatch` input or git tag)
- builds worker platform tarballs on a multi-OS matrix
- downloads all tarballs in the release job
- publishes in strict order:
	1. platform packages
	2. `@nvent-addon/workflow-worker` meta package
	3. existing JS packages (`nvent`, `@nvent-addon/app`)

Publishing helper: `scripts/release-workflow-worker.sh`

## Next Steps

1. Integrate `@nvent-addon/workflow-worker` into the nvent runtime (`WorkflowWorkerManager`).
2. Extend release pipeline to publish all platform packages first, then the meta package.
3. Add release smoke tests that install the packed tarballs and execute `workflow --version`.
