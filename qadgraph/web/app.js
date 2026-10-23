/* =============================================================================
   QadGraph — application logic
   Fix historique : processPoints() appelait updateLinks() AVANT
   simulation.nodes(nodes). d3 résolvait les ids de liens contre une liste de
   noeuds vide -> "node not found" -> pipeline interrompu, graphe vide.
   Ordre correct : nodes -> links (en objets) -> restart.
   ============================================================================= */
(function () {
  "use strict";

  var THRESHOLD = 0.65;
  var REFRESH_MS = 15000;
  var TOP_K = 8;

  var TYPE_COLORS = {
    decision: "#22d3ee",
    project_fact: "#a855f7",
    user_preference: "#10b981",
    workflow: "#f43f5e",
    lesson: "#f59e0b",
    environment: "#ec4899",
    semantic: "#818cf8",
    agent: "#34d399",
    episodic: "#fcd34d",
    ref: "#fb7185",
    user: "#a3e635",
    unknown: "#64748b"
  };
  function typeColor(t) { return TYPE_COLORS[t] || TYPE_COLORS.unknown; }

  var S = {
    view: "topology",
    metrics: null,
    graph: { nodes: [], edges: [] },
    nodeByIndex: {},
    selected: null,
    hovered: null,
    typeFilter: null,
    showLabels: true,
    showEdges: true,
    colorByType: true,
    spin: true,
    search: "",
    lastSync: null
  };

  // ------------------------------------------------------------------ helpers
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function trunc(s, n) {
    s = String(s === null || s === undefined ? "" : s);
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return Number(n).toLocaleString("fr-FR");
  }
  function bytes(n) {
    if (!n) return "0 o";
    if (n < 1024) return n + " o";
    if (n < 1048576) return (n / 1024).toFixed(1) + " Ko";
    if (n < 1073741824) return (n / 1048576).toFixed(2) + " Mo";
    return (n / 1073741824).toFixed(2) + " Go";
  }
  function nowLabel() {
    try { return new Date().toLocaleTimeString("fr-FR"); }
    catch (e) { return new Date().toTimeString().slice(0, 8); }
  }
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove("show"); }, 1900);
  }
  async function api(path, opts) {
    var res = await fetch(path, opts);
    if (!res.ok) throw new Error(path + " -> HTTP " + res.status);
    return res.json();
  }
  function post(path, payload) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }

  // ------------------------------------------------------------------ tooltip
  var tip = $("tooltip");
  function showTip(n, x, y) {
    tip.innerHTML =
      '<div class="t" style="color:' + typeColor(n.type) + '">' + esc(trunc(n.type, 28)) + '</div>' +
      '<div class="r"><span>degré</span><b>' + n.d + '</b></div>' +
      (n.session ? '<div class="r"><span>session</span><b>' + esc(trunc(n.session, 18)) + '</b></div>' : "") +
      (n.importance !== null && n.importance !== undefined ? '<div class="r"><span>importance</span><b>' + n.importance + '</b></div>' : "") +
      '<div class="x">' + esc(trunc(n.text, 190)) + '</div>';
    tip.classList.add("show");
    var w = tip.offsetWidth || 300, h = tip.offsetHeight || 110;
    var left = x + 16, top = y + 16;
    if (left + w > window.innerWidth - 12) left = x - w - 14;
    if (top + h > window.innerHeight - 12) top = Math.max(10, y - h - 12);
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }
  function hideTip() { tip.classList.remove("show"); }

  // ================================================================== GRAPH 3D
  // Sphere de memoire vectorielle : simulation d3-force-3d, camera orbitale
  // libre, rotation automatique, picking par projection ecran.
  var canvas = $("graph-canvas");
  var ctx = canvas.getContext("2d");
  var W = 0, H = 0, DPR = 1;
  var sim = null;
  var sprites = {};
  var dragNode = null;
  var userInteracted = false;
  var fitTimer = null;
  var rafId = null;
  var SPIN = 0.35;          // vitesse de rotation (0 = arret, 1 = rapide)
  var is3D = true;
  var SHELL_R = 250;
  var PITCH_LIMIT = Math.PI;   // rotation complete : la boule tourne dans tous les sens

  // camera orbitale : yaw autour de Y, pitch autour de X
  var CAM = { yaw: 0.62, pitch: -0.34, zoom: 1, panX: 0, panY: 0, focal: 1600 };
  var vel = { yaw: 0, pitch: 0 };
  var camAnim = null;

  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function scheduleFit(delay) {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(function () { if (!userInteracted) fitView(); }, delay || 700);
  }

  // ---------------------------------------------------------------- projection
  function project(p) {
    var cy = Math.cos(CAM.yaw), sy = Math.sin(CAM.yaw);
    var x1 = p.x * cy - p.z * sy;
    var z1 = p.x * sy + p.z * cy;
    var cp = Math.cos(CAM.pitch), sp = Math.sin(CAM.pitch);
    var y2 = p.y * cp - z1 * sp;
    var z2 = p.y * sp + z1 * cp;
    var persp = CAM.focal / (CAM.focal - z2);
    var k = CAM.zoom * persp;
    return { x: W / 2 + (x1 + CAM.panX) * k, y: H / 2 + (y2 + CAM.panY) * k, z: z2, k: k };
  }
  function toCam(p) {
    var cy = Math.cos(CAM.yaw), sy = Math.sin(CAM.yaw);
    var x1 = p.x * cy - p.z * sy;
    var z1 = p.x * sy + p.z * cy;
    var cp = Math.cos(CAM.pitch), sp = Math.sin(CAM.pitch);
    return { x: x1, y: p.y * cp - z1 * sp, z: p.y * sp + z1 * cp };
  }
  function fromCam(c) {
    var cp = Math.cos(CAM.pitch), sp = Math.sin(CAM.pitch);
    var y = c.y * cp + c.z * sp;
    var z1 = -c.y * sp + c.z * cp;
    var cy = Math.cos(CAM.yaw), sy = Math.sin(CAM.yaw);
    return { x: c.x * cy + z1 * sy, y: y, z: -c.x * sy + z1 * cy };
  }
  function dragTo(n, clientX, clientY) {
    var cam = toCam(n);
    var rect = canvas.getBoundingClientRect();
    var sx = clientX - rect.left, sy = clientY - rect.top;
    var persp = CAM.focal / (CAM.focal - cam.z);
    var w = fromCam({
      x: (sx - W / 2) / (CAM.zoom * persp) - CAM.panX,
      y: (sy - H / 2) / (CAM.zoom * persp) - CAM.panY,
      z: cam.z
    });
    n.fx = w.x; n.fy = w.y; n.fz = w.z;
  }

  // ---------------------------------------------------------------- sprites
  function makeSprite(color) {
    var size = 128;
    var c = document.createElement("canvas");
    c.width = size; c.height = size;
    var g = c.getContext("2d");
    var grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, rgba(color, 1));
    grd.addColorStop(0.18, rgba(color, 0.62));
    grd.addColorStop(0.45, rgba(color, 0.16));
    grd.addColorStop(1, rgba(color, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  }
  function rgba(hex, a) {
    var h = hex.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }
  function sprite(color) {
    if (!sprites[color]) sprites[color] = makeSprite(color);
    return sprites[color];
  }

  // ---------------------------------------------------------------- layout 3D
  function resizeCanvas() {
    var r = canvas.getBoundingClientRect();
    DPR = window.devicePixelRatio || 1;
    W = Math.max(200, r.width);
    H = Math.max(200, r.height);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    if (sim) sim.force("center", d3.forceCenter(0, 0, 0));
    requestRender();
  }

  function nodeRadius(n) {
    return Math.min(3.2 + Math.sqrt(n.d || 0) * 1.25, 14);
  }
  function nodeVisible(n) {
    return !S.typeFilter || n.type === S.typeFilter;
  }
  function nodeColor(n) {
    if (!S.colorByType) return "#22d3ee";
    return typeColor(n.type);
  }

  // coque radiale : les noeuds les plus connectes au centre, les autres sur
  // la coque -> une vraie sphere, pas un nuage.
  function shellTarget(n, maxDeg) {
    var t = Math.min(1, (n.degree || 0) / maxDeg);
    return SHELL_R * (0.55 + 0.45 * (1 - t));
  }
  function shellForce() {
    var nodes = S.graph.nodes, maxDeg = 1, i;
    for (i = 0; i < nodes.length; i++) if (nodes[i].degree > maxDeg) maxDeg = nodes[i].degree;
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var r = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
      if (r < 1e-4) { n.x = Math.random() - 0.5; n.z = Math.random() - 0.5; r = 1; }
      var target = shellTarget(n, maxDeg);
      var f = (r - target) * 0.30;
      n.vx -= (n.x / r) * f;
      n.vy -= (n.y / r) * f;
      n.vz -= (n.z / r) * f;
      if (n.fx === null || n.fx === undefined) {
        var k = 1 + 0.13 * (target - r) / r;
        n.x *= k; n.y *= k; n.z *= k;
      }
    }
  }

  function buildGraph(payload) {
    var prev = {};
    (S.graph.nodes || []).forEach(function (n) { prev[n.id] = n; });

    var nodes = payload.nodes.map(function (p) {
      var old = prev[p.id];
      var n = {
        index: p.i,
        id: p.id,
        type: p.type,
        session: p.session,
        text: p.text,
        importance: p.importance,
        status: p.status,
        source: p.source,
        created: p.created,
        d: p.d,
        degree: p.d
      };
      n.r = nodeRadius(n);
      if (old) { n.x = old.x; n.y = old.y; n.z = old.z; n.vx = old.vx; n.vy = old.vy; n.vz = old.vz; }
      else {
        var a = (p.i / Math.max(1, payload.nodes.length)) * Math.PI * 2 * 7;
        var b = Math.acos(1 - 2 * (p.i + 0.5) / Math.max(1, payload.nodes.length));
        var rad = 90 + (p.i % 7) * 20;
        n.x = Math.sin(b) * Math.cos(a) * rad;
        n.y = Math.cos(b) * rad;
        n.z = Math.sin(b) * Math.sin(a) * rad;
      }
      return n;
    });

    // liens en OBJETS : plus aucune resolution d'id par d3 (bug historique)
    var byIndex = {};
    nodes.forEach(function (n) { byIndex[n.index] = n; });
    var links = [];
    (payload.edges || []).forEach(function (e, li) {
      var a = byIndex[e.s], b = byIndex[e.t];
      if (!a || !b) return;
      // courbure deterministe : les liens ne se superposent jamais
      var h = (e.s * 73856093) ^ (e.t * 19349663);
      links.push({ source: a, target: b, value: e.v, bend: ((h % 1000) / 500 - 1) });
    });

    S.graph.nodes = nodes;
    S.graph.edges = links;
    S.nodeByIndex = byIndex;

    if (sim) sim.stop();
    try {
      sim = d3.forceSimulation(nodes, 3);
      if (typeof sim.numDimensions === "function") sim.numDimensions(3);
    } catch (e) {
      sim = d3.forceSimulation(nodes);
    }
    sim
      .force("link", d3.forceLink(links)
        .distance(function (d) { return 30 + (1 - d.value) * 55; })
        .strength(function (d) { return 0.02 + d.value * 0.10; })
        .iterations(1))
      .force("charge", d3.forceManyBody().strength(-95).distanceMax(520))
      .force("center", d3.forceCenter(0, 0, 0))
      .force("shell", shellForce)
      .force("collide", d3.forceCollide(function (d) { return d.r + 2.5; }).iterations(2))
      .alphaDecay(0.028)
      .on("tick", requestRender)
      .on("end", function () { scheduleFit(120); });

    sim.alpha(0.9).restart();
    buildLegend();
    requestRender();
    scheduleFit(900);
  }

  function buildLegend() {
    var counts = {};
    S.graph.nodes.forEach(function (n) { counts[n.type] = (counts[n.type] || 0) + 1; });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 7);
    var box = $("graph-legend");
    box.innerHTML = "";
    keys.forEach(function (t) {
      var chip = el("span", "lg" + (S.typeFilter === t ? " on" : ""),
        '<i style="background:' + typeColor(t) + '"></i>' + esc(t) + ' ' + counts[t]);
      chip.addEventListener("click", function () {
        S.typeFilter = (S.typeFilter === t) ? null : t;
        buildLegend();
        requestRender();
      });
      box.appendChild(chip);
    });
  }

  // ---------------------------------------------------------------- rendu
  function requestRender() {
    if (rafId === null) rafId = requestAnimationFrame(frame);
  }

  function frame() {
    rafId = null;
    var busy = false;
    if (camAnim) {
      var t = Math.min(1, (nowMs() - camAnim.t0) / camAnim.dur);
      var e = 1 - Math.pow(1 - t, 3);
      CAM.yaw = camAnim.y0 + (camAnim.y1 - camAnim.y0) * e;
      CAM.pitch = camAnim.p0 + (camAnim.p1 - camAnim.p0) * e;
      if (t >= 1) camAnim = null;
      busy = true;
    } else if (Math.abs(vel.yaw) > 0.00002 || Math.abs(vel.pitch) > 0.00002) {
      CAM.yaw += vel.yaw;
      CAM.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, CAM.pitch + vel.pitch));
      vel.yaw *= 0.93;
      vel.pitch *= 0.93;
      busy = true;
    } else if (S.spin && is3D) {
      CAM.yaw += 0.0016 + SPIN * 0.0042;
      busy = true;
    }
    render();
    if (busy || (sim && sim.alpha() > sim.alphaMin())) requestRender();
  }

  function render() {
    if (!ctx) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var nodes = S.graph.nodes;
    if (!nodes.length) return;

    var i, n, p;
    var pts = [];
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      p = project(n);
      n._p = p;
      pts.push(n);
    }
    pts.sort(function (a, b) { return a._p.z - b._p.z; });   // arriere -> avant

    // halo de la sphere
    var c0 = project({ x: 0, y: 0, z: 0 });
    var Rs = SHELL_R * CAM.zoom * 1.05;
    var grd = ctx.createRadialGradient(c0.x, c0.y, Rs * 0.1, c0.x, c0.y, Rs);
    grd.addColorStop(0, "rgba(34,211,238,0.055)");
    grd.addColorStop(0.55, "rgba(34,211,238,0.018)");
    grd.addColorStop(1, "rgba(34,211,238,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(c0.x, c0.y, Rs, 0, Math.PI * 2);
    ctx.fill();
    // cage : trois grands cercles qui rendent la rotation 3D lisible
    ctx.strokeStyle = "rgba(34,211,238,0.10)";
    ctx.lineWidth = 0.9;
    for (var ring = 0; ring < 3; ring++) {
      ctx.beginPath();
      for (i = 0; i <= 64; i++) {
        var t = (i / 64) * Math.PI * 2;
        var q = { x: 0, y: 0, z: 0 };
        if (ring === 0) { q.x = Math.cos(t) * SHELL_R; q.y = Math.sin(t) * SHELL_R; }
        else if (ring === 1) { q.y = Math.cos(t) * SHELL_R; q.z = Math.sin(t) * SHELL_R; }
        else { q.x = Math.cos(t) * SHELL_R; q.z = Math.sin(t) * SHELL_R; }
        var qp = project(q);
        if (i === 0) ctx.moveTo(qp.x, qp.y); else ctx.lineTo(qp.x, qp.y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // aretes : courbes en ecran, gradient de couleur, profondeur respectee
    if (S.showEdges) {
      var BANDS = 3;
      var paths = [];
      for (i = 0; i < BANDS; i++) paths.push(new Path2D());
      var selPath = new Path2D();
      for (i = 0; i < S.graph.edges.length; i++) {
        var l = S.graph.edges[i];
        if (!l.source._p || !l.target._p) continue;
        if (!nodeVisible(l.source) && !nodeVisible(l.target)) continue;
        var a = l.source._p, b = l.target._p;
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        var dx = b.x - a.x, dy = b.y - a.y;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        var bend = l.bend * Math.min(46, len * 0.2);
        var cx = mx - (dy / len) * bend;
        var cy = my + (dx / len) * bend;
        var target;
        if (S.selected && (l.source === S.selected || l.target === S.selected)) target = selPath;
        else {
          var band = l.value > 0.8 ? 2 : (l.value > 0.72 ? 1 : 0);
          target = paths[band];
        }
        target.moveTo(a.x, a.y);
        target.quadraticCurveTo(cx, cy, b.x, b.y);
      }
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      var styles = [
        ["rgba(96,150,210,0.055)", 0.7],
        ["rgba(34,211,238,0.115)", 0.9],
        ["rgba(34,211,238,0.235)", 1.25]
      ];
      for (i = 0; i < BANDS; i++) {
        ctx.strokeStyle = styles[i][0];
        ctx.lineWidth = styles[i][1];
        ctx.stroke(paths[i]);
      }
      // liens du noeud selectionne : halo + coeur net
      ctx.strokeStyle = "rgba(34,211,238,0.25)";
      ctx.lineWidth = 4.5;
      ctx.stroke(selPath);
      ctx.strokeStyle = "rgba(120,240,255,0.95)";
      ctx.lineWidth = 1.4;
      ctx.stroke(selPath);
      ctx.restore();
    }

    // noeuds : halo additif puis coeur plein
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (i = 0; i < pts.length; i++) {
      var nd = pts[i];
      var col = nodeColor(nd);
      var isSel = nd === S.selected, isHov = nd === S.hovered;
      var rr = nodeRadius(nd) * (isSel ? 1.6 : (isHov ? 1.3 : 1)) * (nd._p.k || 1);
      if (rr < 0.8) rr = 0.8;
      ctx.globalAlpha = (nodeVisible(nd) ? 1 : 0.10) * 0.55;
      var gs = rr * 3.2;
      ctx.drawImage(sprite(col), nd._p.x - gs / 2, nd._p.y - gs / 2, gs, gs);
    }
    ctx.restore();

    ctx.save();
    for (i = 0; i < pts.length; i++) {
      var n2 = pts[i];
      var isSel2 = n2 === S.selected, isHov2 = n2 === S.hovered;
      var rr2 = nodeRadius(n2) * (isSel2 ? 1.6 : (isHov2 ? 1.3 : 1)) * (n2._p.k || 1);
      if (rr2 < 0.8) rr2 = 0.8;
      ctx.globalAlpha = nodeVisible(n2) ? 1 : 0.12;
      ctx.beginPath();
      ctx.arc(n2._p.x, n2._p.y, Math.max(1, rr2 * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = nodeColor(n2);
      ctx.fill();
    }
    ctx.restore();

    // anneau de selection
    if (S.selected && S.selected._p) {
      var sr = nodeRadius(S.selected) * (S.selected._p.k || 1) + 7;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.beginPath();
      ctx.arc(S.selected._p.x, S.selected._p.y, sr + 2.5 * Math.sin(nowMs() / 320), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(34,211,238,0.95)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();
    }

    // labels : les plus connectes, collision ecran
    if (S.showLabels) {
      var ranked = nodes.slice().sort(function (a, b) { return (b.d || 0) - (a.d || 0); });
      var limit = Math.min(ranked.length, CAM.zoom > 2 ? 48 : (CAM.zoom > 1 ? 30 : 16));
      ctx.font = "500 10px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      var placed = [];
      for (i = 0; i < limit; i++) {
        var ln = ranked[i];
        if (!ln._p || !nodeVisible(ln)) continue;
        if (ln !== S.selected && ln !== S.hovered && (ln.d || 0) <= 0) continue;
        var txt = trunc(ln.text, 26);
        var tw = ctx.measureText(txt).width;
        var bx = ln._p.x + nodeRadius(ln) * (ln._p.k || 1) + 5;
        var by = ln._p.y;
        var box = { x1: bx, x2: bx + tw, y1: by - 6, y2: by + 6 };
        var clash = false;
        if (ln !== S.selected && ln !== S.hovered) {
          for (var q = 0; q < placed.length; q++) {
            var b = placed[q];
            if (box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1) { clash = true; break; }
          }
        }
        if (clash) continue;
        placed.push(box);
        ctx.globalAlpha = ln === S.selected ? 1 : 0.62;
        ctx.fillStyle = ln === S.selected ? "#ffffff" : "rgba(198,220,245,0.9)";
        ctx.fillText(txt, bx, by);
      }
      ctx.globalAlpha = 1;
    }

    updateHud();
  }

  function updateHud() {
    var yaw = ((CAM.yaw * 180 / Math.PI) % 360 + 360) % 360;
    var pitch = (CAM.pitch * 180 / Math.PI);
    var txt = "<b>" + S.graph.nodes.length + "</b> noeuds · <b>" + S.graph.edges.length + "</b> edges"
      + "<br>seuil <b>" + THRESHOLD.toFixed(2) + "</b> · zoom <b>" + CAM.zoom.toFixed(2) + "×</b>"
      + "<br>orbite <b>" + yaw.toFixed(0) + "°</b> / <b>" + pitch.toFixed(0) + "°</b>"
      + "<br>moteur <b>" + (is3D ? "3D" : "2D") + "</b> · rotation <b>" + (S.spin ? "on" : "off") + "</b>";
    if (S.typeFilter) txt += "<br>filtre <b>" + esc(S.typeFilter) + "</b>";
    txt += "<br><span style='color:var(--dim)'>clic vide : recentrer · glisser : tourner</span>";
    $("graph-hud").innerHTML = txt;
  }

  // ---------------------------------------------------------------- camera
  function sphereRadius() {
    var r = 1;
    S.graph.nodes.forEach(function (n) {
      var d = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
      if (d > r) r = d;
    });
    return r;
  }
  function fitView() {
    if (!S.graph.nodes.length) return;
    var r = sphereRadius();
    var avail = Math.min(W, H) * 0.5 * 0.86;
    CAM.zoom = Math.max(0.2, Math.min(4, avail / r));
    CAM.panX = 0; CAM.panY = 0;
    requestRender();
  }
  function resetCamera() {
    camAnim = null;
    CAM.yaw = 0.62; CAM.pitch = -0.34; CAM.panX = 0; CAM.panY = 0;
    vel.yaw = 0; vel.pitch = 0;
    userInteracted = false;
    fitView();
  }
  function animateCam(toYaw, toPitch, dur) {
    var d = toYaw - CAM.yaw;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    camAnim = { y0: CAM.yaw, p0: CAM.pitch, y1: CAM.yaw + d, p1: toPitch, t0: nowMs(), dur: dur || 520 };
    vel.yaw = 0; vel.pitch = 0;
    requestRender();
  }
  // amene un noeud face a la camera, au centre
  function focusOn(n) {
    if (!n) return;
    var rho = Math.sqrt(n.x * n.x + n.z * n.z);
    animateCam(Math.atan2(n.x, n.z), Math.atan2(n.y, rho), 560);
    CAM.panX = 0; CAM.panY = 0;
    CAM.zoom = Math.max(CAM.zoom, Math.min(2.4, (Math.min(W, H) * 0.5 * 0.42) / sphereRadius()));
    requestRender();
  }

  // ---------------------------------------------------------------- picking
  function hitTest(cx, cy) {
    var best = null, bestScore = Infinity;
    for (var i = 0; i < S.graph.nodes.length; i++) {
      var n = S.graph.nodes[i];
      if (!n._p || !nodeVisible(n)) continue;
      var dx = n._p.x - cx, dy = n._p.y - cy;
      var d = Math.sqrt(dx * dx + dy * dy);
      var r = Math.max(8, nodeRadius(n) * (n._p.k || 1) + 5);
      if (d > r) continue;
      var score = d - n._p.z * 0.8;    // privilegie le noeud le plus proche
      if (score < bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  // ---------------------------------------------------------------- pointeur
  var mode = null, lastX = 0, lastY = 0, moved = 0;

  canvas.addEventListener("pointerdown", function (ev) {
    userInteracted = true;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
    lastX = ev.clientX; lastY = ev.clientY; moved = 0;
    var n = hitTest(ev.clientX - canvas.getBoundingClientRect().left,
                    ev.clientY - canvas.getBoundingClientRect().top);
    if (n && !ev.shiftKey) {
      mode = "node";
      dragNode = n;
      n.fx = n.x; n.fy = n.y; n.fz = n.z;
      if (sim) sim.alphaTarget(0.22).restart();
    } else {
      mode = ev.shiftKey ? "pan" : "orbit";
      camAnim = null;
      vel.yaw = 0; vel.pitch = 0;
      canvas.classList.add("grabbing");
    }
  });

  canvas.addEventListener("pointermove", function (ev) {
    var rect = canvas.getBoundingClientRect();
    var dx = ev.clientX - lastX, dy = ev.clientY - lastY;
    if (mode === "node" && dragNode) {
      moved += Math.abs(dx) + Math.abs(dy);
      dragTo(dragNode, ev.clientX, ev.clientY);
      lastX = ev.clientX; lastY = ev.clientY;
      requestRender();
      return;
    }
    if (mode === "orbit") {
      moved += Math.abs(dx) + Math.abs(dy);
      CAM.yaw += dx * 0.006;
      CAM.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, CAM.pitch - dy * 0.006));
      vel.yaw = dx * 0.0016;
      vel.pitch = -dy * 0.0016;
      lastX = ev.clientX; lastY = ev.clientY;
      requestRender();
      return;
    }
    if (mode === "pan") {
      moved += Math.abs(dx) + Math.abs(dy);
      CAM.panX += dx / CAM.zoom;
      CAM.panY += dy / CAM.zoom;
      lastX = ev.clientX; lastY = ev.clientY;
      requestRender();
      return;
    }
    var n = hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
    if (n !== S.hovered) {
      S.hovered = n;
      canvas.classList.toggle("pointing", !!n);
      requestRender();
    }
    if (n) showTip(n, ev.clientX, ev.clientY); else hideTip();
  });

  function endPointer() {
    if (dragNode) {
      if (sim) sim.alphaTarget(0);
      if (moved <= 6) { dragNode.fx = null; dragNode.fy = null; dragNode.fz = null; }
      dragNode = null;
    }
    mode = null;
    canvas.classList.remove("grabbing");
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", function () {
    S.hovered = null; hideTip(); requestRender();
  });

  canvas.addEventListener("dblclick", function (ev) {
    var rect = canvas.getBoundingClientRect();
    var n = hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
    if (n) {
      n.fx = null; n.fy = null; n.fz = null;
      if (sim) sim.alpha(0.35).restart();
      requestRender();
    }
  });

  canvas.addEventListener("wheel", function (ev) {
    ev.preventDefault();
    userInteracted = true;
    var f = Math.exp(-ev.deltaY * 0.0013);
    CAM.zoom = Math.max(0.15, Math.min(8, CAM.zoom * f));
    requestRender();
  }, { passive: false });

  canvas.addEventListener("click", function (ev) {
    if (moved > 6) return;
    var rect = canvas.getBoundingClientRect();
    var n = hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
    if (n) {
      selectNode(n);
    } else {
      // clic dans le vide : la boule revient en place
      selectNode(null);
      resetCamera();
      toast("Vue réinitialisée");
    }
  });

  // ================================================================== PANEL
  function selectNode(n) {
    S.selected = n;
    if (n) {
      api("/api/node?index=" + n.index).then(renderDetail).catch(function () { renderDetail(n); });
    } else {
      loadRecent();
    }
    render();
  }

  function renderDetail(n) {
    var body = $("panel-body");
    $("panel-title").textContent = "Point Detail";
    body.innerHTML = "";
    var head = el("div", "section");
    head.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px">' +
      '<span class="pill" style="color:' + typeColor(n.type) + '">' + esc(n.type) + '</span>' +
      '<div style="margin-left:auto;display:flex;gap:6px">' +
      '<button class="btn sm" id="d-focus">Center</button>' +
      '<button class="btn sm" id="d-copy">Copy</button>' +
      '<button class="btn sm" id="d-close">✕</button>' +
      '</div></div>';
    body.appendChild(head);

    var kv = el("div", "section");
    kv.innerHTML = '<h4>Métadonnées</h4><div class="kv">' +
      row("Type", n.type) +
      row("ID", n.id) +
      row("Session", n.session || "—") +
      row("Importance", n.importance === null || n.importance === undefined ? "—" : n.importance) +
      row("Status", n.status || "—") +
      row("Source", n.source || "—") +
      row("Degré", n.d) +
      row("Vecteur", (S.metrics && S.metrics.collection.dims ? S.metrics.collection.dims : "?") + " dims") +
      '</div>';
    body.appendChild(kv);

    var tx = el("div", "section");
    tx.innerHTML = '<h4>Texte du payload</h4><div class="payload">' + esc(n.text) + '</div>';
    body.appendChild(tx);

    if (n.neighbors && n.neighbors.length) {
      var nb = el("div", "section");
      nb.innerHTML = '<h4>' + TOP_K + ' voisins les plus similaires</h4>';
      n.neighbors.forEach(function (v) {
        var d = el("div", "neighbor",
          '<div class="top"><span class="score">' + v.score.toFixed(4) + '</span>' +
          '<span class="type" style="color:' + typeColor(v.type) + ';font-size:9px;font-weight:800;text-transform:uppercase">' + esc(v.type) + '</span></div>' +
          '<div class="txt">' + esc(trunc(v.text, 150)) + '</div>');
        d.addEventListener("click", function () {
          var target = S.graph.nodes.filter(function (g) { return g.id === v.id; })[0];
          if (target) { selectNode(target); focusOn(target); }
        });
        nb.appendChild(d);
      });
      body.appendChild(nb);
    }
    $("d-close").addEventListener("click", function () { selectNode(null); });
    $("d-copy").addEventListener("click", function () { copyText(n.text, "d-copy"); });
    $("d-focus").addEventListener("click", function () { focusOn(n); });
  }
  function row(k, v) {
    return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
  }
  function copyText(txt, id) {
    var b = $(id);
    var done = function () {
      b.textContent = "OK";
      setTimeout(function () { b.textContent = "Copy"; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, done);
    } else { done(); }
  }
  function focusOn(n) {
    if (!n) return;
    var rho = Math.sqrt(n.x * n.x + n.z * n.z);
    animateCam(Math.atan2(n.x, n.z), Math.atan2(n.y, rho), 560);
    CAM.panX = 0; CAM.panY = 0;
    CAM.zoom = Math.max(CAM.zoom, Math.min(2.4, (Math.min(W, H) * 0.5 * 0.42) / sphereRadius()));
    requestRender();
  }

  function loadRecent() {
    $("panel-title").textContent = "Recent Entries";
    return api("/api/recent?limit=14").then(function (r) {
      var body = $("panel-body");
      body.innerHTML = "";
      if (!r.points || !r.points.length) {
        body.innerHTML = '<div class="empty">Aucune donnée.</div>';
        return;
      }
      r.points.forEach(function (p) {
        var idx = S.graph.nodes.filter(function (g) { return g.id === p.id; })[0];
        var e = el("div", "entry",
          '<div class="top"><span class="type" style="color:' + typeColor(p.type) + '">' + esc(p.type) + '</span>' +
          '<span class="deg">deg ' + (idx ? idx.d : 0) + '</span></div>' +
          '<div class="txt">' + esc(trunc(p.text, 150)) + '</div>' +
          '<div class="meta">' + esc(trunc(p.session || "no-session", 26)) + '</div>');
        e.addEventListener("click", function () {
          if (idx) { selectNode(idx); focusOn(idx); }
        });
        body.appendChild(e);
      });
    });
  }

  // ================================================================== VUES
  function showView(name) {
    S.view = name;
    document.querySelectorAll(".nav-item").forEach(function (n) {
      n.classList.toggle("active", n.getAttribute("data-view") === name);
    });
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.toggle("active", v.getAttribute("data-view") === name);
    });
    if (name === "topology") { resizeCanvas(); scheduleFit(320); }
    if (name === "collections") loadCollections();
    if (name === "metrics") loadMetrics();
    if (name === "logs") loadLogs();
    if (name === "config") loadConfig();
    if (name === "search") setTimeout(function () { $("search-input").focus(); }, 60);
  }

  function loadCollections() {
    api("/api/collections").then(function (r) {
      var cols = r.collections || [];
      $("badge-collections").textContent = cols.length;
      $("coll-hint").textContent = cols.length + " collection(s) · qdrant " + (r.qdrant_version || "?");
      var tb = $("coll-table").querySelector("tbody");
      tb.innerHTML = "";
      cols.forEach(function (c) {
        var tr = el("tr", "clickable");
        var statusColor = c.status === "green" ? "#10b981" : (c.status === "yellow" ? "#f59e0b" : "#f43f5e");
        tr.innerHTML =
          '<td class="mono" style="color:#e6efff">' + esc(c.name) + '</td>' +
          '<td><span class="pill" style="color:' + statusColor + '">' + esc(c.status) + '</span></td>' +
          '<td class="num">' + fmt(c.points) + '</td>' +
          '<td class="num">' + fmt(c.indexed) + '</td>' +
          '<td class="num">' + fmt(c.segments) + '</td>' +
          '<td class="num">' + (c.dims || "—") + '</td>' +
          '<td>' + esc(c.distance || "—") + '</td>' +
          '<td>' + esc(c.optimizer || "—") + '</td>';
        tr.addEventListener("click", function () {
          api("/api/collection/" + encodeURIComponent(c.name)).then(function (d) {
            showCollectionDetail(d);
          });
        });
        tb.appendChild(tr);
      });

      var m = S.metrics;
      var schema = (m && m.payload_schema) || [];
      var st = $("schema-table").querySelector("tbody");
      st.innerHTML = "";
      schema.forEach(function (s) {
        var tr = el("tr");
        tr.innerHTML =
          '<td class="mono" style="color:#e6efff">' + esc(s.field) + '</td>' +
          '<td>' + esc(s.data_type) + '</td>' +
          '<td class="num">' + fmt(s.points) + '</td>' +
          '<td class="num">' + s.coverage + '%</td>' +
          '<td><div class="meter"><i style="width:' + s.coverage + '%"></i></div></td>';
        st.appendChild(tr);
      });

      var c0 = cols[0] || {};
      $("coll-stats").innerHTML =
        statTile("c", fmt(c0.points), "Points collection", c0.name || "—") +
        statTile("b", c0.dims || "—", "Dimensions", c0.distance || "—") +
        statTile("a", fmt(c0.segments), "Segments", "optimizer " + (c0.optimizer || "?")) +
        statTile("e", fmt(cols.length), "Collections", "qdrant " + (r.qdrant_version || "?"));
    });
  }

  function showCollectionDetail(c) {
    $("panel-title").textContent = "Collection";
    var body = $("panel-body");
    body.innerHTML = "";
    var s = el("div", "section");
    s.innerHTML = '<h4>Overview</h4><div class="kv">' +
      row("Name", c.name) + row("Status", c.status) + row("Points", c.points) +
      row("Indexed", c.indexed) + row("Segments", c.segments) +
      row("Dims", c.dims) + row("Distance", c.distance) + row("Optimizer", c.optimizer) + '</div>';
    body.appendChild(s);
    var p = el("div", "section");
    p.innerHTML = '<h4>Config</h4><pre class="code">' + esc(JSON.stringify(c.config, null, 2)) + '</pre>';
    body.appendChild(p);
  }

  function statTile(cls, value, label, detail) {
    return '<div class="card stat ' + cls + '"><span class="v">' + value + '</span>' +
      '<span class="l">' + label + '</span>' +
      (detail ? '<span class="d">' + esc(detail) + '</span>' : "") + '</div>';
  }

  function loadMetrics() {
    if (!S.metrics) return;
    var m = S.metrics;
    $("metric-tiles").innerHTML =
      statTile("c", fmt(m.collection.points), "Points", m.collection.name) +
      statTile("b", m.collection.dims || "—", "Dimensions", m.collection.distance || "—") +
      statTile("v", fmt(m.graph.edges), "Edges", "seuil " + m.graph.threshold) +
      statTile("e", m.graph.avg_degree, "Degré moyen", "max " + m.graph.max_degree) +
      statTile("a", m.similarity.max, "Similarité max", "moy " + m.similarity.mean) +
      statTile("r", fmt(m.graph.isolated), "Nœuds isolés", "densité " + m.graph.density) +
      statTile("b", bytes(m.memory.vector_bytes), "Vecteurs", bytes(m.memory.payload_bytes_est) + " payload") +
      statTile("c", m.last_refresh_ms + " ms", "Temps de refresh", "cache " + m.refresh_count + " cycles");

    drawHistogram($("chart-sim"), m.similarity.histogram, "#22d3ee");
    drawBars($("chart-type"), m.distribution.type, "#a855f7");

    var tt = $("top-table").querySelector("tbody");
    tt.innerHTML = "";
    S.graph.nodes.slice().sort(function (a, b) { return b.d - a.d; }).slice(0, 12).forEach(function (n, i) {
      var tr = el("tr", "clickable");
      tr.innerHTML = '<td class="num">' + (i + 1) + '</td>' +
        '<td><span class="pill" style="color:' + typeColor(n.type) + '">' + esc(n.type) + '</span></td>' +
        '<td>' + esc(trunc(n.text, 60)) + '</td>' +
        '<td class="num">' + n.d + '</td>';
      tr.addEventListener("click", function () { selectNode(n); focusOn(n); });
      tt.appendChild(tr);
    });

    var st = $("session-table").querySelector("tbody");
    st.innerHTML = "";
    var total = m.collection.points || 1;
    (m.distribution.session || []).forEach(function (s) {
      var tr = el("tr");
      tr.innerHTML = '<td class="mono">' + esc(trunc(s.name, 28)) + '</td>' +
        '<td class="num">' + fmt(s.count) + '</td>' +
        '<td class="num">' + ((s.count / total) * 100).toFixed(1) + '%</td>';
      st.appendChild(tr);
    });

    $("coll-config").textContent = JSON.stringify(m.collection.config, null, 2);
  }

  function drawHistogram(canvasEl, data, color) {
    var ctx2 = canvasEl.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var w = canvasEl.parentElement.clientWidth, h = 210;
    canvasEl.width = w * dpr; canvasEl.height = h * dpr;
    canvasEl.style.width = w + "px"; canvasEl.style.height = h + "px";
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, w, h);
    if (!data || !data.length) return;
    var max = Math.max.apply(null, data.map(function (d) { return d.count; })) || 1;
    var pad = 24, bw = (w - pad * 2) / data.length;
    data.forEach(function (d, i) {
      var bh = (d.count / max) * (h - 46);
      var x = pad + i * bw + 3, y = h - 22 - bh;
      var g = ctx2.createLinearGradient(0, y, 0, h - 22);
      g.addColorStop(0, rgba(color, 0.95));
      g.addColorStop(1, rgba(color, 0.25));
      ctx2.fillStyle = g;
      ctx2.beginPath();
      ctx2.roundRect(x, y, bw - 6, Math.max(1, bh), 4);
      ctx2.fill();
      ctx2.fillStyle = "rgba(150,175,205,0.75)";
      ctx2.font = "9px 'JetBrains Mono', monospace";
      ctx2.textAlign = "center";
      ctx2.fillText(d.bin, x + (bw - 6) / 2, h - 8);
      if (d.count) {
        ctx2.fillStyle = "rgba(220,235,255,0.9)";
        ctx2.fillText(String(d.count), x + (bw - 6) / 2, y - 4);
      }
    });
  }

  function drawBars(canvasEl, data, color) {
    var ctx2 = canvasEl.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var w = canvasEl.parentElement.clientWidth, h = 210;
    canvasEl.width = w * dpr; canvasEl.height = h * dpr;
    canvasEl.style.width = w + "px"; canvasEl.style.height = h + "px";
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, w, h);
    if (!data || !data.length) return;
    var max = data[0].count || 1;
    var rows = data.slice(0, 8);
    var lh = Math.min(22, (h - 16) / rows.length);
    rows.forEach(function (d, i) {
      var y = 8 + i * lh;
      var bw = (w - 150) * (d.count / max);
      ctx2.fillStyle = "rgba(150,175,205,0.85)";
      ctx2.font = "10px 'JetBrains Mono', monospace";
      ctx2.textAlign = "left";
      ctx2.fillText(trunc(d.name, 18), 0, y + lh / 2);
      var g = ctx2.createLinearGradient(140, 0, 140 + bw, 0);
      g.addColorStop(0, rgba(color, 0.35));
      g.addColorStop(1, rgba(color, 0.95));
      ctx2.fillStyle = g;
      ctx2.beginPath();
      ctx2.roundRect(140, y + 3, Math.max(2, bw), lh - 8, 3);
      ctx2.fill();
      ctx2.fillStyle = "rgba(220,235,255,0.95)";
      ctx2.textAlign = "right";
      ctx2.fillText(String(d.count), w - 2, y + lh / 2);
    });
  }

  function loadLogs() {
    api("/api/logs?tail=140&stream=stdout").then(function (r) {
      $("logs-out").innerHTML = (r.lines || []).map(function (l) {
        return '<div class="logline' + (/error|warn|panic/i.test(l) ? " warn" : "") + '">' + esc(l) + "</div>";
      }).join("") || '<div class="empty">Journal vide.</div>';
      $("logs-hint").textContent = (r.lines || []).length + " lignes";
    });
    api("/api/logs?tail=140&stream=stderr").then(function (r) {
      $("logs-err").innerHTML = (r.lines || []).map(function (l) {
        return '<div class="logline err">' + esc(l) + "</div>";
      }).join("") || '<div class="empty">Aucune erreur.</div>';
    });
  }

  function loadConfig() {
    api("/api/config").then(function (c) {
      $("mcp-config").textContent = c.mcp_config;
      $("server-config").textContent = JSON.stringify(c.server, null, 2);
      $("qdrant-config").textContent = c.qdrant_config;
      $("qdrant-config-path").textContent = c.qdrant_config_path;
    });
  }

  // -- recherche
  function runSearch() {
    var q = $("search-input").value.trim();
    S.search = q;
    if (!q) { $("search-results").innerHTML = '<div class="empty">Tapez une recherche.</div>'; return; }
    $("search-hint").textContent = "recherche…";
    api("/api/search?q=" + encodeURIComponent(q) + "&limit=12").then(function (r) {
      var res = r.results || [];
      $("search-hint").textContent = res.length + " résultat(s)";
      if (!res.length) {
        $("search-results").innerHTML = '<div class="empty">Aucun résultat.</div>';
        return;
      }
      $("search-results").innerHTML = "";
      res.forEach(function (v) {
        var e = el("div", "entry",
          '<div class="top"><span class="type" style="color:' + typeColor(v.type) + '">' + esc(v.type) + '</span>' +
          (v.score ? '<span class="score" style="font-family:JetBrains Mono,monospace;font-size:10px;color:#22d3ee">' + v.score.toFixed(4) + '</span>' : "") +
          '<span class="deg">' + esc(trunc(v.session || "no-session", 22)) + '</span></div>' +
          '<div class="txt">' + esc(trunc(v.text, 240)) + '</div>');
        e.addEventListener("click", function () {
          var target = S.graph.nodes.filter(function (g) { return g.id === v.id; })[0];
          if (target) { showView("topology"); selectNode(target); focusOn(target); }
        });
        $("search-results").appendChild(e);
      });
    });
  }

  // ================================================================== SYNC
  function applyMetrics(m) {
    S.metrics = m;
    var c = m.collection || {};
    $("k-points").textContent = fmt(c.points);
    $("k-dims").textContent = c.dims || "—";
    $("k-distance").textContent = c.distance || "—";
    $("k-edges").textContent = fmt(m.graph.edges);
    $("k-degree").textContent = m.graph.avg_degree;
    $("k-indexed").textContent = fmt(c.indexed);
    $("k-refresh").textContent = m.last_refresh ? nowLabel() : "—";
    $("brand-collection").textContent = c.name || "qdrant";
    $("status-dot").className = "dot " + (m.status === "ok" ? "ok" : "bad");
    $("status-text").textContent = m.status === "ok" ? "connecté" : (m.error || "déconnecté");
    $("status-meta").textContent = "qdrant " + (m.version || "?") + " · " + (c.name || "");
    $("status-latency").textContent = m.last_refresh_ms + " ms · " + (m.refresh_count || 0) + " cycles";
  }

  async function sync(full) {
    try {
      var m = await api("/api/metrics?threshold=" + THRESHOLD);
      applyMetrics(m);
      if (full) {
        var g = await api("/api/graph?threshold=" + THRESHOLD);
        buildGraph(g);
        loadRecent();
      }
      if (S.view === "metrics") loadMetrics();
      if (S.view === "collections") loadCollections();
    } catch (e) {
      $("status-dot").className = "dot bad";
      $("status-text").textContent = "erreur: " + e.message;
    }
  }

  async function syncGraph() {
    try {
      var g = await api("/api/graph?threshold=" + THRESHOLD);
      buildGraph(g);
    } catch (e) { /* silencieux */ }
  }

  // ================================================================== EVENTS
  document.querySelectorAll(".nav-item").forEach(function (n) {
    n.addEventListener("click", function () { showView(n.getAttribute("data-view")); });
  });
  $("btn-refresh").addEventListener("click", function () {
    post("/api/refresh", {}).then(function () { sync(true); toast("Données synchronisées"); });
  });
  $("threshold").addEventListener("input", function () {
    THRESHOLD = parseFloat(this.value);
    $("threshold-val").textContent = THRESHOLD.toFixed(2);
    clearTimeout(window._thr);
    window._thr = setTimeout(syncGraph, 220);
  });
  $("btn-labels").addEventListener("click", function () {
    S.showLabels = !S.showLabels;
    this.classList.toggle("on", S.showLabels);
    requestRender();
  });
  $("btn-edges").addEventListener("click", function () {
    S.showEdges = !S.showEdges;
    this.classList.toggle("on", S.showEdges);
    requestRender();
  });
  $("btn-spin").addEventListener("click", function () {
    S.spin = !S.spin;
    this.classList.toggle("on", S.spin);
    requestRender();
    toast(S.spin ? "Rotation automatique activée" : "Rotation automatique arrêtée");
  });
  $("btn-3d").addEventListener("click", function () {
    is3D = !is3D;
    this.textContent = is3D ? "3D" : "2D";
    this.classList.toggle("on", is3D);
    if (!is3D) {
      camAnim = null;
      CAM.yaw = 0; CAM.pitch = -Math.PI / 2;
      vel.yaw = 0; vel.pitch = 0;
      S.spin = false;
      $("btn-spin").classList.remove("on");
    }
    userInteracted = false;
    scheduleFit(300);
    requestRender();
    toast(is3D ? "Vue 3D orbitale" : "Vue 2D (vue de dessus)");
  });
  $("btn-help").addEventListener("click", function () { $("help").classList.toggle("show"); });
  $("help").addEventListener("click", function (ev) { if (ev.target === this) this.classList.remove("show"); });
  $("spin-speed").addEventListener("input", function () {
    SPIN = parseFloat(this.value) / 100;
    $("spin-val").textContent = SPIN.toFixed(2);
    if (SPIN > 0 && !S.spin) { S.spin = true; $("btn-spin").classList.add("on"); }
    requestRender();
  });
  $("btn-fit").addEventListener("click", function () { resetCamera(); });
  $("btn-zoom-in").addEventListener("click", function () {
    userInteracted = true;
    CAM.zoom = Math.min(8, CAM.zoom * 1.25);
    requestRender();
  });
  $("btn-zoom-out").addEventListener("click", function () {
    userInteracted = true;
    CAM.zoom = Math.max(0.15, CAM.zoom / 1.25);
    requestRender();
  });
  $("btn-unpin").addEventListener("click", function () {
    S.graph.nodes.forEach(function (n) { n.fx = null; n.fy = null; n.fz = null; });
    if (sim) sim.alpha(0.4).restart();
    requestRender();
    toast("Nœuds libérés");
  });
  $("btn-search").addEventListener("click", runSearch);
  $("search-input").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") runSearch();
  });
  $("btn-copy-mcp").addEventListener("click", function () { copyText($("mcp-config").textContent, "btn-copy-mcp"); });
  $("btn-copy-mcp-win").addEventListener("click", function () {
    var cfg = JSON.parse($("mcp-config").textContent);
    var s = cfg.mcpServers.qadgraph;
    var txt = "python.exe \"" + s.args[0] + "\"\n" +
      "  (variables d’environnement : QADGRAPH_QDRANT=" + s.env.QADGRAPH_QDRANT +
      ", QADGRAPH_COLLECTION=" + s.env.QADGRAPH_COLLECTION + ")";
    copyText(txt, "btn-copy-mcp-win");
  });

  document.addEventListener("keydown", function (ev) {
    var tag = ev.target && ev.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (ev.key === "Escape") ev.target.blur();
      return;
    }
    if (ev.key === "/") { ev.preventDefault(); showView("search"); }
    else if (ev.key === "r" || ev.key === "R") { sync(true); toast("Sync forcé"); }
    else if (ev.key === "l" || ev.key === "L") { $("btn-labels").click(); }
    else if (ev.key === "d" || ev.key === "D") { $("btn-edges").click(); }
    else if (ev.key === "f" || ev.key === "F") { fitView(); }
    else if (ev.key === "u" || ev.key === "U") { $("btn-unpin").click(); }
    else if (ev.key === "1") showView("topology");
    else if (ev.key === "2") showView("collections");
    else if (ev.key === "3") showView("search");
    else if (ev.key === "4") showView("metrics");
    else if (ev.key === "5") showView("logs");
    else if (ev.key === "6") showView("config");
  });

  window.addEventListener("resize", function () {
    resizeCanvas();
    if (S.view === "metrics" && S.metrics) loadMetrics();
  });

  // ================================================================== BOOT
  resizeCanvas();
  sync(true).then(loadRecent);
  setInterval(function () {
    if (!document.hidden) sync(false);
  }, REFRESH_MS);

  window.__QG = S;
})();
