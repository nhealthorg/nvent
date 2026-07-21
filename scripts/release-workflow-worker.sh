#!/bin/bash

set -euo pipefail

VERSION="${1:-}"
ARTIFACT_DIR="${2:-.release-artifacts/workflow-worker}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release-workflow-worker.sh <version> [artifact-dir]"
  exit 1
fi

get_dist_tag() {
  local ver="$1"
  if [[ "$ver" =~ -alpha ]]; then
    echo "alpha"
  elif [[ "$ver" =~ -beta ]]; then
    echo "beta"
  elif [[ "$ver" =~ -rc ]]; then
    echo "rc"
  else
    echo "latest"
  fi
}

DIST_TAG=$(get_dist_tag "$VERSION")
echo "📦 Publishing workflow-worker packages (dist-tag: ${DIST_TAG})"

publish_tgz() {
  local file="$1"
  local package_name="$2"

  if [[ ! -f "$file" ]]; then
    echo "❌ Missing artifact for $package_name: $file"
    exit 1
  fi

  echo "⚡ Publishing $package_name from $(basename "$file")"
  if npm publish "$file" --access public --tag "$DIST_TAG" 2>&1; then
    echo "✅ $package_name published successfully"
  else
    echo "ℹ️  $package_name might already be published at this version"
  fi
}

publish_tgz "$ARTIFACT_DIR/nvent-addon-workflow-worker-linux-x64-gnu-$VERSION.tgz" "@nvent-addon/workflow-worker-linux-x64-gnu"
publish_tgz "$ARTIFACT_DIR/nvent-addon-workflow-worker-linux-arm64-gnu-$VERSION.tgz" "@nvent-addon/workflow-worker-linux-arm64-gnu"
publish_tgz "$ARTIFACT_DIR/nvent-addon-workflow-worker-darwin-x64-$VERSION.tgz" "@nvent-addon/workflow-worker-darwin-x64"
publish_tgz "$ARTIFACT_DIR/nvent-addon-workflow-worker-darwin-arm64-$VERSION.tgz" "@nvent-addon/workflow-worker-darwin-arm64"
publish_tgz "$ARTIFACT_DIR/nvent-addon-workflow-worker-win32-x64-msvc-$VERSION.tgz" "@nvent-addon/workflow-worker-win32-x64-msvc"

echo "⚡ Publishing @nvent-addon/workflow-worker"
cd packages/workflow-worker/workflow-worker-meta
if npm publish --access public --tag "$DIST_TAG" 2>&1; then
  echo "✅ @nvent-addon/workflow-worker published successfully"
else
  echo "ℹ️  @nvent-addon/workflow-worker might already be published at this version"
fi

echo "✅ Workflow-worker packages published"
