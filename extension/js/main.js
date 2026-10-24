/* Gragarda GeoTrack — panneau After Effects */
(function () {
  'use strict';
  var P = window.GTPose;
  var N = window.GTNode;
  var backend = new window.GTBackend();
  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- état
  var S = {
    footage: null,      // infos du calque (host.jsx)
    frameCount: 0,
    fIn: 0, fOut: 0,
    frame: 0,
    mesh: null,         // {spec, vertices, edges, pickPoints, nVerts, nFaces, targetSize}
    focal: 26, zoom: 0,
    keys: {},           // frame -> {rvec, tvec}
    pins: {},           // frame -> [{X:[x,y,z], target:[u,v]}]
    tracked: {},        // frame -> {rvec, tvec, quality}
    pose: null,         // pose affichée/éditée : {rvec, tvec, src: 'key'|'track'|'est'|'init'}
    img: null, imgFrame: -1,
    view: { zoom: 1, panX: 0, panY: 0 },
    conv: null,         // convention de rotation d'AE (mesurée)
    busy: false
  };

  // ---------------------------------------------------------------- utilitaires
  function setStatus(msg, kind) {
    var el = $('status');
    el.textContent = msg;
    el.className = kind || '';
    el.title = msg;
  }
  function setProgress(p) {
    var bar = $('progress');
    if (p === null || p === undefined) { bar.classList.remove('on'); return; }
    bar.classList.add('on');
    $('progressFill').style.width = Math.round(p * 100) + '%';
  }
  function evalHost(script) {
    return new Promise(function (resolve, reject) {
      if (!window.__adobe_cep__) return reject(new Error('Ce panneau doit être ouvert dans After Effects.'));
      window.__adobe_cep__.evalScript(script, function (res) {
        var data;
        try { data = JSON.parse(res); } catch (e) { return reject(new Error('Réponse AE illisible : ' + res)); }
        if (!data.ok) return reject(new Error(data.error));
        resolve(data);
      });
    });
  }
  function jsxString(s) { return JSON.stringify(s); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function cam() {
    return { f: S.zoom, cx: S.footage.compWidth / 2, cy: S.footage.compHeight / 2 };
  }
  function frameToTime(f) { return S.footage.startTime + f / S.footage.srcFps; }
  function timeToFrame(t) { return Math.round((t - S.footage.startTime) * S.footage.srcFps); }
  function timecode(t) {
    var fps = S.footage.compFps, fr = Math.round(t * fps), ip = Math.round(fps);
    var ff = fr % ip, s = Math.floor(fr / ip), m = Math.floor(s / 60), h = Math.floor(m / 60);
    function z(n) { return (n < 10 ? '0' : '') + n; }
    return z(h) + ':' + z(m % 60) + ':' + z(s % 60) + ':' + z(ff);
  }
  function sortedNums(obj) { return Object.keys(obj).map(Number).sort(function (a, b) { return a - b; }); }
  function copyPose(p) { return { rvec: p.rvec.slice(), tvec: p.tvec.slice() }; }

  // ---------------------------------------------------------------- sauvegarde
  var saveTimer = null;
  function statePath() {
    if (!S.footage) return null;
    var f = S.footage, dir, base;
    if (f.projectPath) {
      dir = N.path.join(N.path.dirname(f.projectPath), 'GeoTrack');
      base = N.path.basename(f.projectPath).replace(/\.aep$/i, '');
    } else {
      dir = N.path.join(N.os.homedir(), 'Documents', 'Gragarda GeoTrack');
      base = 'projet-non-enregistre';
    }
    var name = [base, f.compName, f.layerName].join('__').replace(/[\/\\:*?"<>|]/g, '_');
    return N.path.join(dir, name + '.json');
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 800);
  }
  function saveState() {
    var p = statePath();
    if (!p) return;
    try {
      N.fs.mkdirSync(N.path.dirname(p), { recursive: true });
      N.fs.writeFileSync(p, JSON.stringify({
        version: 1, footagePath: S.footage.path, focal: S.focal,
        mesh: S.mesh ? { path: S.mesh.spec.path, targetSize: S.mesh.targetSize } : null,
        keys: S.keys, pins: S.pins, tracked: S.tracked
      }));
    } catch (e) { setStatus('Sauvegarde impossible : ' + e.message, 'warn'); }
  }
  function loadState() {
    var p = statePath();
    if (!p || !N.fs.existsSync(p)) return null;
    try { return JSON.parse(N.fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- chargement
  function updateZoom() {
    if (!S.footage) return;
    S.zoom = P.zoomFromFocal(S.focal, S.footage.compWidth);
    $('zoomLabel').textContent = '= Zoom ' + S.zoom.toFixed(1) + ' px';
  }

  function footageSpec() {
    var f = S.footage;
    return { path: f.path, compWidth: f.compWidth, compHeight: f.compHeight, layerScale: f.layerScale, layerOffset: f.layerOffset };
  }

  function loadFootage() {
    setStatus('Lecture du calque sélectionné…');
    evalHost('gt_getFootage()').then(function (f) {
      S.footage = f;
      $('footageLabel').textContent = f.layerName + ' — ' + f.compName;
      $('footageLabel').classList.remove('muted');
      $('btnUseCam').classList.toggle('hidden', !f.cameraZoom);
      S.keys = {}; S.pins = {}; S.tracked = {}; S.mesh = null; S.img = null; S.imgFrame = -1;
      $('meshLabel').textContent = 'aucun'; $('meshLabel').classList.add('muted');
      var saved = loadState();
      if (saved) {
        S.keys = saved.keys || {}; S.pins = saved.pins || {}; S.tracked = saved.tracked || {};
        if (saved.focal) { S.focal = saved.focal; $('focal').value = S.focal; }
      }
      updateZoom();
      setStatus('Démarrage du moteur de tracking…');
      return backend.call('info', { footage: footageSpec() }).then(function (info) {
        S.frameCount = info.frameCount;
        var a = Math.ceil((f.inPoint - f.startTime) * f.srcFps - 1e-6);
        var b = Math.floor((f.outPoint - f.startTime) * f.srcFps - 1e-6);
        S.fIn = clamp(a, 0, Math.max(0, info.frameCount - 1));
        S.fOut = clamp(b, S.fIn, Math.max(0, info.frameCount - 1));
        $('frameInput').min = S.fIn; $('frameInput').max = S.fOut;
        $('backendInfo').textContent = backend.info.label + ' · OpenCV ' + backend.info.opencv;
        var msg = 'Vidéo chargée : ' + (S.fOut - S.fIn + 1) + ' frames.';
        if (f.warnings.length) setStatus('⚠ ' + f.warnings.join(' '), 'warn');
        else setStatus(msg + ' Charge maintenant le mesh .obj de l\'objet.');
        gotoFrame(clamp(timeToFrame(f.compTime), S.fIn, S.fOut), true);
        if (saved && saved.mesh && N.fs.existsSync(saved.mesh.path)) return loadMesh(saved.mesh.path, true);
      });
    }).catch(function (e) { setStatus(e.message, 'error'); })
      .then(refreshUI);
  }

  function pickMeshFile() {
    var path = null;
    if (window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx) {
      var r = window.cep.fs.showOpenDialogEx(false, false, 'Choisis le modèle 3D (.obj)', null, ['obj', 'OBJ']);
      if (r && r.data && r.data.length) path = r.data[0];
    } else {
      path = window.prompt('Chemin complet du fichier .obj :');
    }
    if (path) loadMesh(path, false);
  }

  function loadMesh(path, silent) {
    if (!S.footage) { setStatus('Choisis d\'abord le calque vidéo.', 'warn'); return Promise.resolve(); }
    var target = Math.round(S.footage.compHeight * 0.5);
    setStatus('Chargement du mesh…');
    return backend.call('mesh', { path: path, targetSize: target }).then(function (m) {
      m.targetSize = target;
      S.mesh = m;
      $('meshLabel').textContent = N.path.basename(path) + ' (' + m.nFaces.toLocaleString('fr-FR') + ' faces)';
      $('meshLabel').classList.remove('muted');
      if (!silent) {
        setStatus('Mesh chargé. Clique sur un point du mesh puis glisse-le sur le même point de l\'objet dans l\'image.');
        scheduleSave();
      }
      S.pose = poseAt(S.frame);
      draw(); drawTimeline(); refreshUI();
    }).catch(function (e) { setStatus('Mesh : ' + e.message, 'error'); });
  }

  // ---------------------------------------------------------------- poses
  function defaultPose() {
    return { rvec: [0, 0, 0], tvec: [0, 0, S.zoom * 1.3], src: 'init' };
  }
  function poseAt(f) {
    if (S.keys[f]) return Object.assign(copyPose(S.keys[f]), { src: 'key' });
    if (S.tracked[f]) return Object.assign(copyPose(S.tracked[f]), { src: 'track', quality: S.tracked[f].quality });
    var best = null, bd = 1e9;
    [S.keys, S.tracked].forEach(function (m) {
      Object.keys(m).forEach(function (k) { var d = Math.abs(k - f); if (d < bd) { bd = d; best = m[k]; } });
    });
    if (best) return Object.assign(copyPose(best), { src: 'est' });
    return defaultPose();
  }
  function commitManual() {
    S.keys[S.frame] = copyPose(S.pose);
    S.pose.src = 'key';
    scheduleSave();
    draw(); drawTimeline(); refreshUI();
  }

  // ---------------------------------------------------------------- frames
  var frameReq = { inflight: false, wanted: -1 };
  function requestFrame() {
    if (!S.footage) return;
    frameReq.wanted = S.frame;
    if (frameReq.inflight) return;
    frameReq.inflight = true;
    var f = S.frame;
    backend.call('frame', { footage: footageSpec(), frame: f, maxWidth: 1280 }).then(function (r) {
      var img = new Image();
      img.onload = function () {
        frameReq.inflight = false;
        if (f === S.frame) { S.img = img; S.imgFrame = f; draw(); }
        if (frameReq.wanted !== f) requestFrame();
      };
      img.onerror = function () { frameReq.inflight = false; };
      img.src = 'file://' + encodeURI(r.path) + '?n=' + Date.now();
    }).catch(function (e) {
      frameReq.inflight = false;
      setStatus('Image : ' + e.message, 'error');
    });
  }

  var syncTimer = null;
  function gotoFrame(f, force) {
    if (!S.footage) return;
    f = clamp(Math.round(f), S.fIn, S.fOut);
    if (f === S.frame && !force) return;
    S.frame = f;
    S.pose = poseAt(f);
    $('frameInput').value = f;
    requestFrame();
    draw(); drawTimeline(); refreshUI();
    if ($('syncAE').checked) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(function () {
        evalHost('gt_setTime(' + S.footage.compId + ',' + frameToTime(S.frame) + ')').catch(function () {});
      }, 60);
    }
  }

  // ---------------------------------------------------------------- vue
  var canvas = $('view'), ctx = canvas.getContext('2d');
  function viewXf() {
    var cw = canvas.clientWidth, ch = canvas.clientHeight;
    var W = S.footage ? S.footage.compWidth : 1920, H = S.footage ? S.footage.compHeight : 1080;
    var s = Math.min(cw / W, ch / H) * 0.96 * S.view.zoom;
    return { s: s, ox: (cw - W * s) / 2 + S.view.panX, oy: (ch - H * s) / 2 + S.view.panY };
  }
  function toComp(x, y) { var v = viewXf(); return [(x - v.ox) / v.s, (y - v.oy) / v.s]; }

  function draw() {
    var dpr = window.devicePixelRatio || 1;
    var cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    $('empty').classList.toggle('hidden', !!(S.footage && S.mesh));
    if (!S.footage) { $('hud').textContent = ''; return; }
    var v = viewXf(), W = S.footage.compWidth, H = S.footage.compHeight;
    ctx.save();
    ctx.translate(v.ox, v.oy);
    ctx.scale(v.s, v.s);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (S.img) {
      ctx.globalAlpha = S.imgFrame === S.frame ? 1 : 0.6;
      ctx.drawImage(S.img, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
    ctx.strokeRect(v.ox - 0.5, v.oy - 0.5, W * v.s + 1, H * v.s + 1);

    var pinErr = null;
    if (S.mesh && S.pose) {
      var pr = P.projectAll(S.pose.rvec, S.pose.tvec, S.mesh.vertices, cam());
      var zmin = Infinity, zmax = -Infinity, i;
      for (i = 0; i < pr.length; i++) if (pr[i]) { zmin = Math.min(zmin, pr[i][2]); zmax = Math.max(zmax, pr[i][2]); }
      var color = { key: '61,220,132', track: '56,200,240', est: '255,157,46', init: '255,157,46' }[S.pose.src];
      var alphas = [0.95, 0.5, 0.18], paths = [new Path2D(), new Path2D(), new Path2D()];
      var span = Math.max(1e-6, zmax - zmin);
      for (i = 0; i < S.mesh.edges.length; i++) {
        var e = S.mesh.edges[i], a = pr[e[0]], b = pr[e[1]];
        if (!a || !b) continue;
        var depth = ((a[2] + b[2]) / 2 - zmin) / span;          // 0 = devant, 1 = derrière
        var bucket = depth < 0.4 ? 0 : (depth < 0.7 ? 1 : 2);
        paths[bucket].moveTo(v.ox + a[0] * v.s, v.oy + a[1] * v.s);
        paths[bucket].lineTo(v.ox + b[0] * v.s, v.oy + b[1] * v.s);
      }
      ctx.lineWidth = 1;
      ctx.setLineDash(S.pose.src === 'est' || S.pose.src === 'init' ? [4, 3] : []);
      for (i = 2; i >= 0; i--) { ctx.strokeStyle = 'rgba(' + color + ',' + alphas[i] + ')'; ctx.stroke(paths[i]); }
      ctx.setLineDash([]);

      var pins = S.pins[S.frame] || [];
      if (pins.length) {
        var R = P.rodrigues(S.pose.rvec), sum = 0;
        pins.forEach(function (pin, idx) {
          var pp = P.project(R, S.pose.tvec, pin.X, cam());
          var tx = v.ox + pin.target[0] * v.s, ty = v.oy + pin.target[1] * v.s;
          if (pp) {
            var px = v.ox + pp[0] * v.s, py = v.oy + pp[1] * v.s;
            var d = Math.hypot(pp[0] - pin.target[0], pp[1] - pin.target[1]);
            sum += d;
            if (d * v.s > 1.5) {
              ctx.strokeStyle = '#ff5a52'; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(tx, ty); ctx.stroke();
              ctx.fillStyle = '#ff5a52'; ctx.beginPath(); ctx.arc(px, py, 2, 0, 7); ctx.fill();
            }
          }
          ctx.lineWidth = 2;
          ctx.strokeStyle = idx === drag.pinIndex ? '#fff' : '#ffd23f';
          ctx.beginPath(); ctx.arc(tx, ty, 6, 0, 7); ctx.stroke();
          ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(tx, ty, 1.6, 0, 7); ctx.fill();
          ctx.lineWidth = 1;
        });
        pinErr = sum / pins.length;
      }
    }
    var srcTxt = { key: 'keyframe', track: 'tracké', est: 'pas de pose ici (estimation)', init: 'pose de départ' };
    var lines = ['Frame ' + S.frame + '  ·  ' + timecode(frameToTime(S.frame))];
    if (S.pose && S.mesh) {
      var l2 = srcTxt[S.pose.src];
      if (S.pose.src === 'track' && S.pose.quality !== undefined) l2 += '  ·  fiabilité ' + Math.round(S.pose.quality * 100) + ' %';
      var np = (S.pins[S.frame] || []).length;
      if (np) l2 += '  ·  ' + np + ' pin' + (np > 1 ? 's' : '') + '  ·  écart moyen ' + pinErr.toFixed(1) + ' px';
      lines.push(l2);
    }
    $('hud').textContent = lines.join('\n');
  }

  // ---------------------------------------------------------------- timeline
  var tl = $('timeline'), tctx = tl.getContext('2d');
  function tlX(f) {
    var w = tl.clientWidth, n = Math.max(1, S.fOut - S.fIn);
    return 6 + (f - S.fIn) / n * (w - 12);
  }
  function tlFrame(x) {
    var w = tl.clientWidth, n = Math.max(1, S.fOut - S.fIn);
    return Math.round(S.fIn + (x - 6) / (w - 12) * n);
  }
  function drawTimeline() {
    var dpr = window.devicePixelRatio || 1, w = tl.clientWidth, h = tl.clientHeight;
    if (tl.width !== Math.round(w * dpr) || tl.height !== Math.round(h * dpr)) {
      tl.width = Math.round(w * dpr); tl.height = Math.round(h * dpr);
    }
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.clearRect(0, 0, w, h);
    tctx.fillStyle = '#1b1b1b'; tctx.fillRect(0, 0, w, h);
    if (!S.footage) return;
    // bande de fiabilité
    var y0 = h - 9;
    for (var x = 6; x < w - 6; x++) {
      var f = tlFrame(x), t = S.tracked[f], c = '#3a3a3a';
      if (S.keys[f]) c = '#3ddc84';
      else if (t) c = t.quality >= 0.7 ? '#2fae6a' : (t.quality >= 0.4 ? '#ff9d2e' : '#ff5a52');
      tctx.fillStyle = c; tctx.fillRect(x, y0, 1, 7);
    }
    // keyframes
    tctx.fillStyle = '#3ddc84';
    sortedNums(S.keys).forEach(function (k) {
      var kx = tlX(k);
      tctx.beginPath(); tctx.moveTo(kx, 4); tctx.lineTo(kx + 5, 10); tctx.lineTo(kx, 16); tctx.lineTo(kx - 5, 10); tctx.fill();
    });
    // tête de lecture
    var px = tlX(S.frame);
    tctx.strokeStyle = '#4a9eff'; tctx.lineWidth = 2;
    tctx.beginPath(); tctx.moveTo(px, 0); tctx.lineTo(px, h); tctx.stroke();
  }
  var tlDrag = false;
  tl.addEventListener('pointerdown', function (e) { tlDrag = true; tl.setPointerCapture(e.pointerId); gotoFrame(tlFrame(e.offsetX)); });
  tl.addEventListener('pointermove', function (e) { if (tlDrag) gotoFrame(tlFrame(e.offsetX)); });
  tl.addEventListener('pointerup', function () { tlDrag = false; });

  // ---------------------------------------------------------------- interactions dans la vue
  var drag = { mode: null, pinIndex: -1, last: null };
  var spaceDown = false;

  function hitPin(cx, cy) {
    var pins = S.pins[S.frame] || [], v = viewXf();
    for (var i = pins.length - 1; i >= 0; i--) {
      if (Math.hypot(v.ox + pins[i].target[0] * v.s - cx, v.oy + pins[i].target[1] * v.s - cy) < 9) return i;
    }
    return -1;
  }
  function pickSurface(cx, cy) {
    if (!S.mesh || !S.pose) return null;
    var v = viewXf(), p = toComp(cx, cy), rad = 10 / v.s;
    var R = P.rodrigues(S.pose.rvec), c = cam(), best = null;
    var pts = S.mesh.pickPoints;
    // 1) profondeur du devant au voisinage du clic, 2) point le plus proche du clic parmi ceux du devant
    var near = [];
    for (var i = 0; i < pts.length; i++) {
      var pr = P.project(R, S.pose.tvec, pts[i], c);
      if (!pr) continue;
      var d = Math.hypot(pr[0] - p[0], pr[1] - p[1]);
      if (d < rad) near.push({ i: i, d: d, z: pr[2] });
    }
    if (!near.length) return null;
    var zFront = Math.min.apply(null, near.map(function (n) { return n.z; }));
    var tol = (S.mesh.targetSize || 500) * 0.04;
    near.forEach(function (n) { if (n.z <= zFront + tol && (!best || n.d < best.d)) best = n; });
    return best ? pts[best.i].slice() : null;
  }

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('pointerdown', function (e) {
    if (!S.footage) return;
    canvas.setPointerCapture(e.pointerId);
    drag.last = [e.offsetX, e.offsetY];
    if (spaceDown || e.button === 1) { drag.mode = 'view'; canvas.classList.add('grab'); return; }
    if (!S.mesh || !S.pose) return;
    if (e.button === 2 || e.altKey) { drag.mode = 'orbit'; return; }
    if (e.shiftKey) { drag.mode = 'pan'; return; }
    var hp = hitPin(e.offsetX, e.offsetY);
    if (hp >= 0) { drag.mode = 'pin'; drag.pinIndex = hp; draw(); return; }
    var X = pickSurface(e.offsetX, e.offsetY);
    if (X) {
      var pins = S.pins[S.frame] || (S.pins[S.frame] = []);
      pins.push({ X: X, target: toComp(e.offsetX, e.offsetY) });
      drag.mode = 'pin'; drag.pinIndex = pins.length - 1;
      commitManual();
      return;
    }
    drag.mode = 'orbit';
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!drag.mode) return;
    var dx = e.offsetX - drag.last[0], dy = e.offsetY - drag.last[1];
    drag.last = [e.offsetX, e.offsetY];
    var v = viewXf();
    if (drag.mode === 'view') { S.view.panX += dx; S.view.panY += dy; draw(); return; }
    if (drag.mode === 'orbit') {
      // les pins de la frame contraignent la pose : on les retire si on fait tourner à la main
      var o = P.orbit(S.pose.rvec, S.pose.tvec, -dx * 0.008, dy * 0.008, 0);
      S.pose.rvec = o.rvec;
      if ((S.pins[S.frame] || []).length) S.pins[S.frame] = [];
      commitManual();
      return;
    }
    if (drag.mode === 'pan') {
      var z = S.pose.tvec[2] / S.zoom;
      S.pose.tvec[0] += dx / v.s * z;
      S.pose.tvec[1] += dy / v.s * z;
      if ((S.pins[S.frame] || []).length) S.pins[S.frame] = [];
      commitManual();
      return;
    }
    if (drag.mode === 'pin') {
      var pins = S.pins[S.frame];
      pins[drag.pinIndex].target = toComp(e.offsetX, e.offsetY);
      var sol = P.solvePins(pins, S.pose.rvec, S.pose.tvec, cam());
      S.pose.rvec = sol.rvec; S.pose.tvec = sol.tvec;
      commitManual();
    }
  });
  function endDrag() {
    var wasPin = drag.mode === 'pin';
    drag.mode = null; drag.pinIndex = -1; canvas.classList.remove('grab');
    var pins = S.pins[S.frame] || [];
    if (wasPin && pins.length >= 4) {
      var sol = P.solvePinsGlobal(pins, S.pose.rvec, S.pose.tvec, cam());
      S.pose.rvec = sol.rvec; S.pose.tvec = sol.tvec;
      commitManual();
      return;
    }
    draw();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', function (e) {
    var hp = hitPin(e.offsetX, e.offsetY);
    if (hp < 0) return;
    S.pins[S.frame].splice(hp, 1);
    scheduleSave(); draw(); refreshUI();
  });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (!S.footage) return;
    if (e.metaKey || e.ctrlKey) {
      // zoom de la vue autour du curseur
      var before = toComp(e.offsetX, e.offsetY);
      S.view.zoom = clamp(S.view.zoom * Math.exp(-e.deltaY * 0.0015), 0.25, 12);
      var v = viewXf();
      S.view.panX += e.offsetX - (v.ox + before[0] * v.s);
      S.view.panY += e.offsetY - (v.oy + before[1] * v.s);
      draw();
      return;
    }
    if (!S.mesh || !S.pose) return;
    var k = Math.exp(e.deltaY * 0.0012);
    S.pose.tvec = S.pose.tvec.map(function (t) { return t * k; });
    if ((S.pins[S.frame] || []).length) {
      var sol = P.solvePins(S.pins[S.frame], S.pose.rvec, S.pose.tvec, cam());
      S.pose.rvec = sol.rvec; S.pose.tvec = sol.tvec;
    }
    commitManual();
  }, { passive: false });

  // ---------------------------------------------------------------- actions
  function setKey() {
    if (!S.pose || !S.mesh) return;
    commitManual();
    setStatus('Keyframe posée frame ' + S.frame + '.');
  }
  function delKey() {
    if (!S.keys[S.frame]) return;
    delete S.keys[S.frame];
    delete S.pins[S.frame];
    S.pose = poseAt(S.frame);
    scheduleSave(); draw(); drawTimeline(); refreshUI();
  }
  function clearPins() { S.pins[S.frame] = []; scheduleSave(); draw(); refreshUI(); }
  function resetPose() {
    if (!S.mesh) return;
    S.pose = defaultPose(); S.pins[S.frame] = [];
    commitManual();
  }
  function jumpKey(dir) {
    var ks = sortedNums(S.keys), f = S.frame;
    var target = dir > 0 ? ks.filter(function (k) { return k > f; })[0] : ks.filter(function (k) { return k < f; }).pop();
    if (target !== undefined) gotoFrame(target);
  }

  function runTrack() {
    if (!S.mesh || !S.footage || S.busy) return;
    var mode = $('trackRange').value, f0, f1;
    var keyFrames = sortedNums(S.keys);
    if (mode === 'all') { f0 = S.fIn; f1 = S.fOut; }
    else if (mode === 'keys') { f0 = keyFrames[0]; f1 = keyFrames[keyFrames.length - 1]; }
    else if (mode === 'fwd') { f0 = S.frame; f1 = S.fOut; }
    else { f0 = S.fIn; f1 = S.frame; }
    var kfs = keyFrames.filter(function (k) { return k >= f0 && k <= f1; })
      .map(function (k) { return { frame: k, rvec: S.keys[k].rvec, tvec: S.keys[k].tvec }; });
    if ((mode === 'fwd' || mode === 'bwd') && !S.keys[S.frame] && S.tracked[S.frame]) {
      kfs.push({ frame: S.frame, rvec: S.tracked[S.frame].rvec, tvec: S.tracked[S.frame].tvec });
      kfs.sort(function (a, b) { return a.frame - b.frame; });
    }
    if (!kfs.length) {
      setStatus('Aligne le mesh sur au moins une frame de la plage (une keyframe verte) avant de tracker.', 'warn');
      return;
    }
    // budget mémoire : les images de la plage sont gardées en niveaux de gris
    var n = f1 - f0 + 1, W = S.footage.compWidth, H = S.footage.compHeight;
    var maxWidth = Math.round(clamp(Math.sqrt(1.2e9 * W / H / n), 480, 1280));
    S.busy = true; refreshUI();
    setStatus('Tracking de ' + n + ' frames…');
    setProgress(0);
    var t0 = Date.now();
    backend.call('track', {
      footage: footageSpec(), maxWidth: maxWidth, zoom: S.zoom,
      mesh: S.mesh.spec, keyframes: kfs, range: [f0, f1]
    }, function (p, msg) {
      setProgress(p);
      setStatus('Tracking… ' + Math.round(p * 100) + ' % — ' + msg);
    }).then(function (res) {
      for (var f = f0; f <= f1; f++) delete S.tracked[f];
      res.frames.forEach(function (fr) { S.tracked[fr.frame] = { rvec: fr.rvec, tvec: fr.tvec, quality: fr.quality }; });
      var weak = res.frames.filter(function (fr) { return fr.quality < 0.4; }).length;
      var msg = 'Tracking terminé en ' + Math.round((Date.now() - t0) / 1000) + ' s : ' + res.frames.length + ' frames';
      if (res.lost.length) msg += ', ' + res.lost.length + ' perdues (ajoute une keyframe au début de la zone grise)';
      if (weak) msg += ', ' + weak + ' douteuses (en rouge)';
      setStatus(msg + '.', res.lost.length || weak ? 'warn' : '');
      S.pose = poseAt(S.frame);
      scheduleSave();
    }).catch(function (e) {
      setStatus('Tracking : ' + e.message, 'error');
      if (e.trace) console.error(e.trace);
    }).then(function () {
      S.busy = false; setProgress(null);
      draw(); drawTimeline(); refreshUI();
    });
  }

  function clearTrack() {
    S.tracked = {};
    S.pose = poseAt(S.frame);
    scheduleSave(); draw(); drawTimeline(); refreshUI();
    setStatus('Tracking effacé (les keyframes sont conservées).');
  }

  function getConvention() {
    if (S.conv) return Promise.resolve(S.conv);
    var test = [30, 40, 50];
    return evalHost('gt_probeRotation(' + test.join(',') + ')').then(function (r) {
      var found = P.detectConvention(r.matrix, test);
      if (found.err > 1e-3) throw new Error('Convention de rotation d\'AE non reconnue (écart ' + found.err.toFixed(4) + ').');
      S.conv = found.conv;
      return S.conv;
    });
  }

  function applyToAE() {
    if (!S.footage || !S.mesh || S.busy) return;
    var frames = sortedNums(Object.assign({}, S.tracked, S.keys));
    if (!frames.length) { setStatus('Rien à envoyer : aligne au moins une frame ou lance le tracking.', 'warn'); return; }
    S.busy = true; refreshUI();
    setStatus('Mesure des rotations d\'After Effects…');
    getConvention().then(function (conv) {
      var W = S.footage.compWidth, H = S.footage.compHeight;
      var times = frames.map(frameToTime);
      var keys = P.toAEKeys(frames.map(function (f) { return S.keys[f] || S.tracked[f]; }), conv, W, H, S.zoom);
      var meshName = N.path.basename(S.mesh.spec.path).replace(/\.obj$/i, '');
      var note = 'Gragarda GeoTrack — mesh : ' + S.mesh.spec.path +
        '\nLe centre du mesh est à l\'ancrage du null. 1 unité OBJ = ' + S.mesh.spec.scale.toFixed(4) + ' px' +
        (S.mesh.spec.flipYZ ? ' (axes Y et Z inversés : Y vers le haut dans l\'OBJ).' : '.');
      var data = {
        compId: S.footage.compId, zoom: S.zoom,
        cameraName: 'GeoTrack Cam', nullName: 'GeoTrack — ' + meshName,
        times: times, positions: keys.positions, rotations: keys.rotations, note: note,
        parentName: 'GeoTrack — repère', parentRotation: keys.parentRotation
      };
      setStatus('Écriture de ' + times.length + ' keyframes dans AE…');
      return evalHost('gt_apply(' + jsxString(JSON.stringify(data)) + ')');
    }).then(function (r) {
      setStatus('✓ ' + r.keys + ' keyframes écrites sur « ' + r.nullName + ' » + caméra « ' + r.cameraName +
        ' ». Parente tes calques 3D à ce null.');
    }).catch(function (e) { setStatus('Envoi vers AE : ' + e.message, 'error'); })
      .then(function () { S.busy = false; refreshUI(); });
  }

  // ---------------------------------------------------------------- UI
  function refreshUI() {
    var has = !!S.footage, ready = has && !!S.mesh;
    $('btnMesh').disabled = !has || S.busy;
    $('btnFootage').disabled = S.busy;
    ['btnKey', 'btnClearPins', 'btnPrev', 'btnNext', 'btnPrevKey', 'btnNextKey', 'frameInput', 'trackRange']
      .forEach(function (id) { $(id).disabled = !ready || S.busy; });
    $('btnDelKey').disabled = !ready || S.busy || !S.keys[S.frame];
    $('btnTrack').disabled = !ready || S.busy || !Object.keys(S.keys).length;
    $('btnClearTrack').disabled = !ready || S.busy || !Object.keys(S.tracked).length;
    $('btnApply').disabled = !ready || S.busy || !(Object.keys(S.keys).length || Object.keys(S.tracked).length);
    $('focal').disabled = !has || S.busy;
  }

  $('btnFootage').onclick = loadFootage;
  $('btnMesh').onclick = pickMeshFile;
  $('focal').onchange = function () {
    var v = parseFloat($('focal').value);
    if (!(v > 0)) return;
    var hadPoses = Object.keys(S.keys).length;
    S.focal = v; updateZoom();
    if (hadPoses) setStatus('Focale changée : réaligne tes keyframes (les pins se recalent automatiquement en les touchant), puis retracke.', 'warn');
    scheduleSave(); draw();
  };
  $('btnUseCam').onclick = function () {
    if (!S.footage || !S.footage.cameraZoom) return;
    S.focal = Math.round(P.focalFromZoom(S.footage.cameraZoom, S.footage.compWidth) * 100) / 100;
    $('focal').value = S.focal;
    $('focal').onchange();
  };
  $('btnPrev').onclick = function () { gotoFrame(S.frame - 1); };
  $('btnNext').onclick = function () { gotoFrame(S.frame + 1); };
  $('btnPrevKey').onclick = function () { jumpKey(-1); };
  $('btnNextKey').onclick = function () { jumpKey(1); };
  $('frameInput').onchange = function () { gotoFrame(parseInt($('frameInput').value, 10) || 0); };
  $('btnKey').onclick = setKey;
  $('btnDelKey').onclick = delKey;
  $('btnClearPins').onclick = clearPins;
  $('btnTrack').onclick = runTrack;
  $('btnClearTrack').onclick = clearTrack;
  $('btnApply').onclick = applyToAE;
  $('btnHelp').onclick = function () { $('help').classList.remove('hidden'); };
  $('btnCloseHelp').onclick = function () { $('help').classList.add('hidden'); };
  $('help').onclick = function (e) { if (e.target === $('help')) $('help').classList.add('hidden'); };

  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { spaceDown = true; e.preventDefault(); return; }
    if (!S.footage || S.busy) return;
    var k = e.key.toLowerCase();
    if (e.key === 'ArrowLeft') { e.shiftKey ? jumpKey(-1) : gotoFrame(S.frame - 1); }
    else if (e.key === 'ArrowRight') { e.shiftKey ? jumpKey(1) : gotoFrame(S.frame + 1); }
    else if (k === 'k') setKey();
    else if (e.key === 'Delete' || e.key === 'Backspace') delKey();
    else if (k === 'p') clearPins();
    else if (k === 'r') resetPose();
    else if (k === 't') runTrack();
    else if (k === 'f') { S.view = { zoom: 1, panX: 0, panY: 0 }; draw(); }
    else return;
    e.preventDefault();
  });
  document.addEventListener('keyup', function (e) { if (e.code === 'Space') spaceDown = false; });

  // Sur macOS, AE garde ces touches pour lui si on ne les réclame pas (codes de touches Mac)
  if (window.__adobe_cep__ && window.__adobe_cep__.registerKeyEventsInterest) {
    var codes = [123, 124, 40, 51, 117, 35, 15, 17, 3, 49];
    window.__adobe_cep__.registerKeyEventsInterest(JSON.stringify(codes.map(function (c) { return { keyCode: c }; })
      .concat(codes.map(function (c) { return { keyCode: c, shiftKey: true }; }))));
  }

  window.addEventListener('resize', function () { draw(); drawTimeline(); });
  window.addEventListener('beforeunload', function () { saveState(); backend.stop(); });

  // accès en lecture pour les tests automatisés de l'interface (tests/ui_test.py)
  window.__gt = { S: S, viewXf: viewXf, cam: function () { return cam(); } };

  // démarrage : on lance le moteur tout de suite (le premier démarrage peut prendre quelques secondes)
  refreshUI(); draw(); drawTimeline();
  backend.start().then(function (info) {
    $('backendInfo').textContent = info.label + ' · OpenCV ' + info.opencv;
  }).catch(function (e) { setStatus(e.message, 'error'); });
})();
