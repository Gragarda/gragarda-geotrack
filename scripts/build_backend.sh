#!/bin/bash
# Compile le moteur Python en application autonome (pas besoin de Python sur le Mac de l'utilisateur).
# Résultat : extension/bin/geotrack-backend/geotrack-backend
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m pip install --upgrade pip >/dev/null
python3 -m pip install -r backend/requirements.txt pyinstaller
rm -rf build dist extension/bin
python3 -m PyInstaller --noconfirm --clean --onedir --name geotrack-backend \
  --collect-submodules cv2 backend/geotrack.py
mkdir -p extension/bin
cp -R dist/geotrack-backend extension/bin/geotrack-backend
# test de fumée : le moteur démarre et répond
printf '{"id":1,"cmd":"ping"}\n{"id":2,"cmd":"quit"}\n' | extension/bin/geotrack-backend/geotrack-backend serve | tee /tmp/geotrack_smoke.txt
grep -q '"pong": true' /tmp/geotrack_smoke.txt
echo "Moteur compilé : extension/bin/geotrack-backend"
