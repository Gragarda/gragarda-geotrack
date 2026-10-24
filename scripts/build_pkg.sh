#!/bin/bash
# Fabrique l'installeur macOS (.pkg) à partir de extension/ (moteur compilé inclus).
# Usage : scripts/build_pkg.sh 0.1.0 [suffixe]   (suffixe : apple-silicon, intel…)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:-0.0.0}"
SUFFIX="${2:+-$2}"
ID="com.gragarda.geotrack"
[ -x extension/bin/geotrack-backend/geotrack-backend ] || { echo "Lance d'abord scripts/build_backend.sh"; exit 1; }
STAGE="$(mktemp -d)"
DEST="$STAGE/Library/Application Support/Adobe/CEP/extensions/$ID"
mkdir -p "$DEST"
# le panneau + le moteur compilé (le script Python reste inclus en secours)
cp -R extension/CSXS extension/css extension/js extension/jsx extension/index.html extension/bin "$DEST/"
mkdir -p "$DEST/backend" && cp backend/geotrack.py "$DEST/backend/"
sed -i '' "s/ExtensionBundleVersion=\"[^\"]*\"/ExtensionBundleVersion=\"$VERSION\"/" "$DEST/CSXS/manifest.xml"
mkdir -p dist
pkgbuild --root "$STAGE" --identifier "$ID" --version "$VERSION" --scripts scripts/pkg \
  --install-location / "dist/Gragarda-GeoTrack-$VERSION$SUFFIX.pkg"
# version zip (installation manuelle)
(cd "$STAGE/Library/Application Support/Adobe/CEP/extensions" && ditto -c -k --keepParent "$ID" "$OLDPWD/dist/Gragarda-GeoTrack-$VERSION$SUFFIX-extension.zip")
rm -rf "$STAGE"
ls -la dist
