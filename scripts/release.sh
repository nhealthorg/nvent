#!/bin/bash

set -e

VERSION="${1:-}"

# Determine npm dist-tag from version string.
# Pre-release versions (e.g. 1.0.0-alpha.1, 1.0.0-beta.2, 1.0.0-rc.1)
# are published under the matching tag; everything else goes to 'latest'.
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
echo "📦 Publishing nvent monorepo packages (dist-tag: ${DIST_TAG})"

publish_package() {
  local package_name=$1
  local package_path=$2

  echo "⚡ Publishing $package_name"
  cd "$package_path"

  if npm publish --access public --tag "$DIST_TAG" 2>&1; then
    echo "✅ $package_name published successfully"
  else
    echo "ℹ️  $package_name might already be published at this version"
  fi

  cd - > /dev/null
}

publish_package "nvent" "packages/nvent"
publish_package "@nvent-addon/app" "packages/app"

echo "✅ All packages published successfully"
