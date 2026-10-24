#!/bin/bash
# Installation "développeur" depuis un clone du repo, sans compiler :
#  - lien symbolique du panneau dans ~/Library/Application Support/Adobe/CEP/extensions
#  - environnement Python dédié (~/.gragarda-geotrack/venv) avec numpy + opencv
#  - autorisation des extensions non signées (PlayerDebugMode)
# Les modifications du code sont prises en compte en fermant/rouvrant le panneau.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gragarda.geotrack"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
ln -s "$REPO/extension" "$DEST"
# le panneau cherche backend/ à côté de lui
ln -sfn "$REPO/backend" "$REPO/extension/backend"
VENV="$HOME/.gragarda-geotrack/venv"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip >/dev/null
"$VENV/bin/pip" install -r backend/requirements.txt
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
echo "OK. Redémarre After Effects puis : Fenêtre > Extensions > Gragarda GeoTrack"
