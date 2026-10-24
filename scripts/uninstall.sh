#!/bin/bash
# Désinstalle Gragarda GeoTrack. Usage : sudo bash scripts/uninstall.sh
set -e
rm -rf "/Library/Application Support/Adobe/CEP/extensions/com.gragarda.geotrack"
rm -rf "$HOME/Library/Application Support/Adobe/CEP/extensions/com.gragarda.geotrack"
pkgutil --forget com.gragarda.geotrack 2>/dev/null || true
echo "Gragarda GeoTrack désinstallé. Redémarre After Effects."
