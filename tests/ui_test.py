"""Test de l'interface du panneau dans Chromium (sans After Effects).

- le vrai panneau (index.html, main.js, pose.js) est chargé dans un navigateur headless ;
- After Effects est simulé (gt_getFootage, gt_probeRotation, gt_apply) ;
- le vrai moteur Python tourne derrière un petit pont HTTP.

Scénario, comme un utilisateur :
  1. charger la vidéo et le mesh, régler la focale ;
  2. frame 0 : poser 4 pins à la souris et les glisser sur les coins du cube ;
  3. tracker tout le calque ;
  4. dernière frame : corriger avec des pins (nouvelle keyframe), retracker ;
  5. "Envoyer vers AE" et vérifier que les keyframes envoyées retombent sur le cube.

Utilisation : python3 tests/ui_test.py [--shots DOSSIER]   (code de sortie 0 = OK)
Dépendance en plus : playwright (pip install playwright && playwright install chromium)
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import synth  # noqa: E402
from synth import g, W, H, N, VW, FPS, ZOOM, V  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--shots", default=None, help="dossier où enregistrer des captures d'écran")
args = ap.parse_args()

tmp = tempfile.mkdtemp(prefix="geotrack_ui_")
files = synth.make_clip(tmp)

# ------------------------------------------------------------- pont HTTP -> moteur
proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "backend", "geotrack.py"), "serve"],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
assert json.loads(proc.stdout.readline()).get("ready")
lock = threading.Lock()


class Bridge(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"])).decode()
        req = json.loads(body)
        with lock:
            proc.stdin.write(json.dumps(req) + "\n")
            proc.stdin.flush()
            while True:
                msg = json.loads(proc.stdout.readline())
                if "progress" not in msg:
                    break
        data = json.dumps(msg).encode()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)


server = HTTPServer(("127.0.0.1", 0), Bridge)
threading.Thread(target=server.serve_forever, daemon=True).start()
bridge_url = f"http://127.0.0.1:{server.server_address[1]}/"

# ------------------------------------------------------------- panneau + simulations
harness = os.path.join(tmp, "panel")
shutil.copytree(os.path.join(ROOT, "extension"), harness)
footage = {
    "compId": 7, "compName": "Comp test", "compWidth": W, "compHeight": H, "compFps": FPS, "compTime": 0,
    "compDuration": N / FPS, "layerName": "clip.mp4", "layerIndex": 1, "path": files["clip"],
    "srcWidth": VW, "srcHeight": 1080, "srcFps": FPS, "startTime": 0, "inPoint": 0, "outPoint": N / FPS,
    "layerScale": W / VW, "layerOffset": [0, 0], "cameraZoom": None, "projectPath": "", "warnings": [],
}
probe = g.rot_ae(30, 40, 50).tolist()  # AE simulé : rotations appliquées X puis Y puis Z
with open(os.path.join(harness, "js", "mock_ae.js"), "w") as fh:
    fh.write(f"""
window.__FOOTAGE = {json.dumps(footage)};
window.__PROBE = {json.dumps(probe)};
window.__applied = null;
window.__adobe_cep__ = {{
  evalScript: function (script, cb) {{ setTimeout(function () {{ cb(window.__mockHost(script)); }}, 5); }},
  getSystemPath: function () {{ return ''; }},
  registerKeyEventsInterest: function () {{}}
}};
window.__mockHost = function (script) {{
  if (script.indexOf('gt_getFootage') === 0) return JSON.stringify(Object.assign({{ ok: true }}, window.__FOOTAGE));
  if (script.indexOf('gt_probeRotation') === 0) return JSON.stringify({{ ok: true, matrix: window.__PROBE, angles: [30, 40, 50] }});
  if (script.indexOf('gt_setTime') === 0) return '{{"ok":true}}';
  if (script.indexOf('gt_apply(') === 0) {{
    window.__applied = JSON.parse(JSON.parse(script.slice(9, -1)));
    return JSON.stringify({{ ok: true, keys: window.__applied.times.length, nullName: window.__applied.nullName, cameraName: window.__applied.cameraName }});
  }}
  return JSON.stringify({{ ok: false, error: 'commande simulée inconnue : ' + script.slice(0, 40) }});
}};
(function () {{
  var BRIDGE = {json.dumps(bridge_url)};
  function Backend() {{ this.info = {{ label: 'pont de test', opencv: '?' }}; this.nextId = 1; }}
  Backend.prototype.start = function () {{ var s = this; return Promise.resolve(s.info); }};
  Backend.prototype.call = function (cmd, payload, onProgress) {{
    var msg = Object.assign({{}}, payload || {{}}, {{ cmd: cmd, id: this.nextId++ }});
    return fetch(BRIDGE, {{ method: 'POST', body: JSON.stringify(msg) }}).then(function (r) {{ return r.json(); }})
      .then(function (m) {{ if (m.ok) return m.result; var e = new Error(m.error); e.trace = m.trace; throw e; }});
  }};
  Backend.prototype.stop = function () {{}};
  window.GTBackend = Backend;
  window.GTNode = {{
    fs: {{ existsSync: function () {{ return false; }}, mkdirSync: function () {{}},
          writeFileSync: function (p, d) {{ window.__saved = {{ p: p, d: d }}; }}, readFileSync: function () {{ return '{{}}'; }} }},
    path: {{ join: function () {{ return Array.prototype.join.call(arguments, '/'); }},
            dirname: function (p) {{ return p.replace(/\\/[^\\/]*$/, ''); }},
            basename: function (p) {{ return p.replace(/^.*\\//, ''); }} }},
    os: {{ homedir: function () {{ return '/home/test'; }} }}
  }};
}})();
""")
idx = os.path.join(harness, "index.html")
html = open(idx).read().replace('<script src="js/backend.js"></script>', '<script src="js/mock_ae.js"></script>')
open(idx, "w").write(html)

# ------------------------------------------------------------- scénario
failures = []


def check(name, cond, detail=""):
    print(("OK    " if cond else "ECHEC ") + name + (f" — {detail}" if detail else ""))
    if not cond:
        failures.append(name)


def shot(page, name):
    if args.shots:
        os.makedirs(args.shots, exist_ok=True)
        page.screenshot(path=os.path.join(args.shots, name))


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--allow-file-access-from-files"])
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    logs = []
    page.on("console", lambda m: logs.append(m.type + ": " + m.text))
    page.on("pageerror", lambda e: logs.append("pageerror: " + str(e)))
    page.on("dialog", lambda d: d.accept(files["obj"]))
    page.goto("file://" + idx)

    page.click("#btnFootage")
    page.wait_for_function("window.__gt.S.frameCount > 0", timeout=30000)
    check("Calque vidéo chargé", page.evaluate("window.__gt.S.fOut") == N - 1,
          f"frames {page.evaluate('window.__gt.S.fIn')}–{page.evaluate('window.__gt.S.fOut')}")

    focal = ZOOM * 36 / W
    page.fill("#focal", str(focal))
    page.dispatch_event("#focal", "change")
    check("Focale -> Zoom", abs(page.evaluate("window.__gt.S.zoom") - ZOOM) < 1e-6)

    page.click("#btnMesh")
    page.wait_for_function("!!window.__gt.S.mesh", timeout=30000)
    scale = page.evaluate("window.__gt.S.mesh.spec.scale")
    check("Mesh chargé", page.evaluate("window.__gt.S.mesh.nFaces") == 12, f"échelle {scale:.3f} px/unité")
    page.wait_for_function("window.__gt.S.imgFrame === 0", timeout=30000)
    shot(page, "1_mesh_charge.png")

    def goto(f):
        page.evaluate(f"(function(){{var i=document.getElementById('frameInput');i.value={f};"
                      f"i.dispatchEvent(new Event('change'));}})()")
        page.wait_for_function(f"window.__gt.S.imgFrame === {f}", timeout=30000)

    def screen_of_vertex(vi):
        """Position écran (px CSS du canvas) du sommet vi avec la pose actuelle du panneau."""
        X = (V[vi] * scale).tolist()
        return page.evaluate("""(X) => {
            const G = window.__gt, S = G.S, v = G.viewXf();
            const p = GTPose.project(GTPose.rodrigues(S.pose.rvec), S.pose.tvec, X, G.cam());
            return p ? [v.ox + p[0] * v.s, v.oy + p[1] * v.s] : null; }""", X)

    def comp_to_screen(pt):
        return page.evaluate("(p) => { const v = window.__gt.viewXf(); return [v.ox + p[0]*v.s, v.oy + p[1]*v.s]; }",
                             [float(pt[0]), float(pt[1])])

    box = page.locator("#view").bounding_box()

    def pin_vertices(frame, verts):
        R, t = synth.pose(frame)
        truth = synth.project(R, t, V)
        placed = 0
        for vi in verts:
            s = screen_of_vertex(vi)
            if s is None:
                continue
            n_before = page.evaluate(f"(window.__gt.S.pins[{frame}] || []).length")
            page.mouse.move(box["x"] + s[0], box["y"] + s[1])
            page.mouse.down()
            picked = page.evaluate(f"(window.__gt.S.pins[{frame}] || []).length") > n_before and \
                np.linalg.norm(np.array(page.evaluate(f"window.__gt.S.pins[{frame}].slice(-1)[0].X")) - V[vi] * scale) < 1.0
            if not picked:  # le clic a attrapé un autre point (sommet caché) : on annule ce pin
                page.mouse.up()
                page.evaluate(f"(function(){{var p=window.__gt.S.pins[{frame}]; if(p && p.length>{n_before}) p.pop();}})()")
                continue
            tgt = comp_to_screen(truth[vi])
            page.mouse.move(box["x"] + tgt[0], box["y"] + tgt[1], steps=8)
            page.mouse.up()
            placed += 1
        return placed

    def pin_error(frame):
        return page.evaluate(f"""(function(){{
            const G = window.__gt, S = G.S, R = GTPose.rodrigues(S.pose.rvec), pins = S.pins[{frame}] || [];
            let e = 0; pins.forEach(p => {{ const q = GTPose.project(R, S.pose.tvec, p.X, G.cam());
              e += Math.hypot(q[0]-p.target[0], q[1]-p.target[1]); }}); return pins.length ? e / pins.length : -1; }})()""")

    # 2) frame 0 : les 4 coins de la face avant
    front = [i for i in range(8) if V[i][2] < 0]
    n0 = pin_vertices(0, front)
    check("Frame 0 : pins posés à la souris", n0 == 4, f"{n0} pins, écart {pin_error(0):.3f} px")
    check("Frame 0 : keyframe créée", page.evaluate("!!window.__gt.S.keys[0]"))
    shot(page, "2_frame0_alignee.png")

    # 3) premier tracking (une seule keyframe)
    page.click("#btnTrack")
    page.wait_for_function("!window.__gt.S.busy && Object.keys(window.__gt.S.tracked).length > 0", timeout=240000)
    print("   statut :", page.inner_text("#status"))

    # 4) dernière frame : correction avec des pins
    goto(N - 1)
    src = page.evaluate("window.__gt.S.pose.src")
    vis = synth.visible_vertices(N - 1)
    n1 = pin_vertices(N - 1, vis)
    check("Dernière frame : pose de départ = tracking", src in ("track", "est"), src)
    check("Dernière frame : correction par pins", n1 >= 4, f"{n1} pins, écart {pin_error(N - 1):.3f} px")
    page.click("#btnTrack")
    page.wait_for_function("!window.__gt.S.busy", timeout=240000)
    page.wait_for_timeout(200)
    status = page.inner_text("#status")
    print("   statut :", status)
    goto(40)
    page.wait_for_timeout(300)
    shot(page, "3_frame40_trackee.png")

    # 5) envoi vers AE (simulé) et vérification géométrique des keyframes
    page.click("#btnApply")
    page.wait_for_function("window.__applied !== null && !window.__gt.S.busy", timeout=30000)
    applied = page.evaluate("window.__applied")
    print("   statut :", page.inner_text("#status"))
    errs = []
    prev = None
    max_jump = 0
    C = g.rot_ae(*applied["parentRotation"]) if applied.get("parentRotation") else np.eye(3)
    print("   repère parent :", applied.get("parentRotation"))
    for t, pos, rot in zip(applied["times"], applied["positions"], applied["rotations"]):
        f = round(t * FPS)
        R = C @ g.rot_ae(*rot)                                    # monde = parent * local
        Xw = (V * scale) @ R.T + C @ np.array(pos)                # monde AE
        cam_pos = np.array([W / 2, H / 2, -applied["zoom"]])
        pc = Xw - cam_pos
        uv = pc[:, :2] / pc[:, 2:3] * applied["zoom"] + [W / 2, H / 2]
        Rt, tt = synth.pose(f)
        errs.append(np.linalg.norm(uv - synth.project(Rt, tt, V), axis=1).mean())
        if prev is not None:
            max_jump = max(max_jump, max(abs(a - b) for a, b in zip(rot, prev)))
        prev = rot
    check("Keyframes envoyées pour chaque frame", len(applied["times"]) == N, f"{len(applied['times'])}")
    check("Keyframes AE : le null retombe sur le cube", np.mean(errs) < 3.0 and np.max(errs) < 10.0,
          f"écart moyen {np.mean(errs):.2f} px, max {np.max(errs):.2f} px")
    check("Rotations AE sans saut", max_jump < 15, f"plus grand saut entre 2 frames {max_jump:.2f}°")
    if np.mean(errs) >= 3.0 or max_jump >= 15:
        print("   écart par frame :", " ".join(f"{e:.1f}" for e in errs))
        print("   pins dernière frame :", json.dumps(page.evaluate(f"window.__gt.S.pins[{N - 1}]"))[:600])
        print("   rotations 70-74 :", applied["rotations"][-5:])
    errors = [l for l in logs if l.startswith("pageerror") or l.startswith("error")]
    check("Aucune erreur JavaScript", not errors, "; ".join(errors)[:300])
    browser.close()

proc.stdin.write('{"cmd":"quit","id":0}\n')
proc.stdin.flush()
server.shutdown()
print("\nRESULTAT:", "OK" if not failures else f"ECHEC ({len(failures)})")
sys.exit(0 if not failures else 1)
