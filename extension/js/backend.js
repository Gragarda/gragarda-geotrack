/*
 * Lance et pilote le moteur de tracking (process persistant, protocole JSON par ligne).
 * Ordre de recherche :
 *   1. binaire autonome installé avec le plugin : <extension>/bin/geotrack-backend/geotrack-backend
 *   2. python3 + <extension>/backend/geotrack.py (mode développeur : numpy + opencv-python requis)
 */
(function (root) {
  'use strict';
  var req = root.require || (root.cep_node && root.cep_node.require);
  var cp = req('child_process'), fs = req('fs'), path = req('path'), os = req('os');

  function extensionDir() {
    var p = root.__adobe_cep__ ? root.__adobe_cep__.getSystemPath('extension') : '';
    p = decodeURIComponent(String(p).replace(/^file:\/\//, ''));
    if (!p) p = path.dirname(path.dirname(root.location.pathname));
    return p;
  }

  function candidates() {
    var ext = extensionDir(), list = [];
    var bin = path.join(ext, 'bin', 'geotrack-backend', 'geotrack-backend');
    if (fs.existsSync(bin)) list.push({ cmd: bin, args: ['serve'], label: 'moteur intégré' });
    var script = path.join(ext, 'backend', 'geotrack.py');
    if (fs.existsSync(script)) {
      var custom = null;
      try { custom = root.localStorage.getItem('gt.python'); } catch (e) {}
      var pys = [custom, path.join(os.homedir(), '.gragarda-geotrack', 'venv', 'bin', 'python3'),
        '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
      pys.forEach(function (py) {
        if (py && fs.existsSync(py)) list.push({ cmd: py, args: [script, 'serve'], label: 'python (' + py + ')' });
      });
    }
    return list;
  }

  function Backend() {
    this.proc = null;
    this.pending = {};
    this.nextId = 1;
    this.info = null;
    this.buffer = '';
    this.lastError = '';
  }

  Backend.prototype._tryStart = function (c) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var env = Object.assign({}, process.env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' });
      var p;
      try { p = cp.spawn(c.cmd, c.args, { env: env, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (e) { return reject(e); }
      var started = false, errText = '';
      var timer = setTimeout(function () {
        if (!started) { try { p.kill(); } catch (e) {} reject(new Error('pas de réponse après 60 s')); }
      }, 60000);
      p.stderr.on('data', function (d) { errText = (errText + d.toString()).slice(-3000); });
      p.on('error', function (e) { clearTimeout(timer); if (!started) reject(e); });
      p.on('exit', function (code) {
        clearTimeout(timer);
        if (!started) return reject(new Error('arrêt immédiat (code ' + code + ') ' + errText.trim().split('\n').pop()));
        self.proc = null;
        self.lastError = errText;
        Object.keys(self.pending).forEach(function (id) {
          self.pending[id].reject(new Error('Le moteur s\'est arrêté. ' + errText.trim().split('\n').pop()));
        });
        self.pending = {};
      });
      p.stdout.on('data', function (d) {
        self.buffer += d.toString();
        var lines = self.buffer.split('\n');
        self.buffer = lines.pop();
        lines.forEach(function (line) {
          if (!line.trim()) return;
          var msg;
          try { msg = JSON.parse(line); } catch (e) { return; }
          if (msg.ready && !started) {
            started = true; clearTimeout(timer);
            self.proc = p; self.info = { label: c.label, opencv: msg.opencv, python: msg.python };
            resolve(self.info);
            return;
          }
          var pend = self.pending[msg.id];
          if (!pend) return;
          if ('progress' in msg) { if (pend.onProgress) pend.onProgress(msg.progress, msg.msg); return; }
          delete self.pending[msg.id];
          if (msg.ok) pend.resolve(msg.result);
          else {
            var err = new Error(msg.error || 'erreur inconnue');
            err.trace = msg.trace;
            pend.reject(err);
          }
        });
      });
    });
  };

  Backend.prototype.start = function () {
    var self = this;
    if (this.proc) return Promise.resolve(this.info);
    if (this._starting) return this._starting;
    var list = candidates(), errors = [];
    if (!list.length) {
      return Promise.reject(new Error('Moteur introuvable : réinstalle le plugin (le dossier bin/ manque).'));
    }
    var i = 0;
    function next() {
      if (i >= list.length) {
        self._starting = null;
        return Promise.reject(new Error('Impossible de démarrer le moteur :\n' + errors.join('\n')));
      }
      var c = list[i++];
      return self._tryStart(c).then(function (info) { self._starting = null; return info; },
        function (e) { errors.push('• ' + c.label + ' : ' + e.message); return next(); });
    }
    this._starting = next();
    return this._starting;
  };

  Backend.prototype.call = function (cmd, payload, onProgress) {
    var self = this;
    return this.start().then(function () {
      return new Promise(function (resolve, reject) {
        var id = self.nextId++;
        var msg = Object.assign({}, payload || {}, { id: id, cmd: cmd });
        self.pending[id] = { resolve: resolve, reject: reject, onProgress: onProgress };
        self.proc.stdin.write(JSON.stringify(msg) + '\n');
      });
    });
  };

  Backend.prototype.stop = function () {
    if (this.proc) { try { this.proc.stdin.write('{"cmd":"quit","id":0}\n'); this.proc.kill(); } catch (e) {} }
    this.proc = null;
  };

  root.GTBackend = Backend;
  root.GTNode = { fs: fs, path: path, os: os, extensionDir: extensionDir };
})(window);
