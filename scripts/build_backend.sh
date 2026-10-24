#!/bin/bash
# Compile le moteur Python en application autonome (pas besoin de Python sur le Mac de l'utilisateur).
# Résultat : extension/bin/geotrack-backend/geotrack-backend
# Usage : scripts/build_backend.sh [arm64|x86_64]   (par défaut : architecture de la machine)
#   x86_64 sur un Mac Apple Silicon : tout tourne sous Rosetta (arch -x86_64) -> moteur 100 % Intel.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH="${1:-$(uname -m)}"
RUN=(arch "-$ARCH")
PY="${PYTHON:-python3}"
VENV=".venv-build-$ARCH"
rm -rf "$VENV" build dist extension/bin
"${RUN[@]}" "$PY" -m venv "$VENV"
"${RUN[@]}" "$VENV/bin/python" -c "import platform; print('Python de build :', platform.machine())"
"${RUN[@]}" "$VENV/bin/python" -m pip install --upgrade pip >/dev/null
"${RUN[@]}" "$VENV/bin/python" -m pip install -r backend/requirements.txt pyinstaller
"${RUN[@]}" "$VENV/bin/python" -m PyInstaller --noconfirm --clean --onedir --name geotrack-backend \
  --target-arch "$ARCH" --collect-submodules cv2 backend/geotrack.py
mkdir -p extension/bin
cp -R dist/geotrack-backend extension/bin/geotrack-backend
BIN=extension/bin/geotrack-backend/geotrack-backend
file "$BIN"
file "$BIN" | grep -q "$ARCH" || { echo "ERREUR : le moteur n'est pas en $ARCH"; exit 1; }
# test de fumée : le moteur démarre et répond
printf '{"id":1,"cmd":"ping"}\n{"id":2,"cmd":"quit"}\n' | "${RUN[@]}" "$BIN" serve | tee /tmp/geotrack_smoke.txt
grep -q '"pong": true' /tmp/geotrack_smoke.txt
echo "Moteur compilé ($ARCH) : $BIN"
