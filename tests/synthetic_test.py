"""Test de bout en bout du moteur de tracking (sans le panneau).

Cube de synthèse (tests/synth.py), 2 keyframes exactes (première et dernière frame),
tracking via le mode serveur comme le fait le panneau, puis mesure de l'écart à l'écran.

Utilisation : python3 tests/synthetic_test.py   (code de sortie 0 = OK)
"""
import json
import math
import os
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synth  # noqa: E402
from synth import g, W, H, N, VW, ZOOM, V  # noqa: E402

BACKEND = os.path.join(HERE, "..", "backend", "geotrack.py")
tmp = tempfile.mkdtemp(prefix="geotrack_test_")
files = synth.make_clip(tmp)


def kf(i):
    R, tv = synth.pose(i)
    return {"frame": i, "rvec": g.R_to_rvec(R).ravel().tolist(), "tvec": tv.tolist()}


job = {
    "footage": {"path": files["clip"], "compWidth": W, "compHeight": H, "layerScale": W / VW, "layerOffset": [0, 0]},
    "zoom": ZOOM,
    "mesh": {"path": files["obj"], "center": [0, 0, 0], "scale": 1.0, "flipYZ": True},
    "keyframes": [kf(0), kf(N - 1)],
    "range": [0, N - 1],
    "maxWidth": 1280,
}

# GEOTRACK_BACKEND=/chemin/vers/geotrack-backend pour tester le moteur compilé au lieu du script
cmd = [os.environ["GEOTRACK_BACKEND"], "serve"] if os.environ.get("GEOTRACK_BACKEND") else [sys.executable, BACKEND, "serve"]
print("moteur :", " ".join(cmd))
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
hello = json.loads(proc.stdout.readline())
assert hello.get("ready"), hello


def call(req):
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()
    while True:
        msg = json.loads(proc.stdout.readline())
        if "progress" in msg:
            continue
        assert msg["ok"], msg
        return msg["result"]


mesh = call({"id": 1, "cmd": "mesh", "path": files["obj"], "targetSize": 200})
assert mesh["nFaces"] == 12 and len(mesh["edges"]) > 0 and len(mesh["pickPoints"]) > 1000, list(mesh)
fr = call({"id": 2, "cmd": "frame", "footage": job["footage"], "frame": 10})
assert os.path.exists(fr["path"]) and fr["width"] == W, fr
res = call(dict(job, id=3, cmd="track"))
call({"id": 4, "cmd": "quit"})
proc.wait(timeout=10)

px, rot_err = [], []
for f in res["frames"]:
    Rt, tt = synth.pose(f["frame"])
    Re, te = g.rt_to_R(f["rvec"]), np.array(f["tvec"])
    px.append(np.linalg.norm(synth.project(Rt, tt, V) - synth.project(Re, te, V), axis=1).mean())
    rot_err.append(math.degrees(math.acos(np.clip((np.trace(Rt.T @ Re) - 1) / 2, -1, 1))))

print(f"frames trackées : {len(res['frames'])}/{N}, perdues : {len(res['lost'])}")
print(f"erreur rotation : moy {np.mean(rot_err):.2f}°, max {np.max(rot_err):.2f}°")
print(f"écart à l'écran (coins du cube) : moy {np.mean(px):.2f} px, max {np.max(px):.2f} px (comp {W}x{H})")
ok = len(res["frames"]) == N and np.mean(px) < 3.0 and np.max(px) < 10.0
print("RESULTAT:", "OK" if ok else "ECHEC")
sys.exit(0 if ok else 1)
