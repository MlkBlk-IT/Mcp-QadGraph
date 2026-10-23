#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QadGraph — plan de controle Qdrant (serveur de dashboard + API metriques).

Choix structurants
------------------
* stdlib uniquement (http.server, urllib, json, threading) : le serveur
  demarre sous n'importe quel Python 3.8+ (tache planifiee SYSTEM comprise),
  sans installer quoi que ce soit.
* Le calcul de similarite cosine est fait COTE SERVEUR sur des vecteurs
  normalises et mis en cache. Le navigateur recoit une topologie leger
  (noeuds + aretes), jamais les 6 Mo de vecteurs bruts.
* Toutes les routes /api/* sont cachees et rafraichies en arriere-plan :
  l'UI reste fluide meme quand la collection grossit.

Routes
------
GET  /                          -> le dashboard (web/index.html)
GET  /assets/<fichier>          -> web/styles.css, web/app.js
GET  /api/health                -> etat du dashboard et de Qdrant
GET  /api/collections           -> toutes les collections + metriques
GET  /api/collection/<nom>      -> metriques detaillees d une collection
GET  /api/graph?threshold=..    -> noeuds + aretes au seuil demande
GET  /api/node?id=..            -> payload complet + voisins les plus proches
GET  /api/search?q=..&limit=..  -> recherche cosine serveur
GET  /api/metrics               -> tableau de bord de metriques agrege
GET  /api/recent?limit=..       -> entrees recentes
GET  /api/logs?tail=..&stream=. -> queue des journaux Qdrant
GET  /api/config                -> config Qdrant + config MCP prete a coller
GET  /api/qdrant/proxy?path=..  -> proxy GET vers Qdrant
POST /api/qdrant/proxy          -> proxy POST (path dans le corps ou la query)
"""
import json
import operator
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
PROJECT = ROOT.parent                      # .../migration-qdrant
QDRANT_DIR = PROJECT / "qdrant"
LOGS_DIR = PROJECT / "logs"

QDRANT_URL = os.environ.get("QADGRAPH_QDRANT", "http://127.0.0.1:6333").rstrip("/")
COLLECTION = os.environ.get("QADGRAPH_COLLECTION", "hermes_qwen3_memory")
HOST = os.environ.get("QADGRAPH_HOST", "127.0.0.1")
PORT = int(os.environ.get("QADGRAPH_PORT", "8766"))
CACHE_TTL = float(os.environ.get("QADGRAPH_CACHE_TTL", "45"))
MAX_MATRIX_N = int(os.environ.get("QADGRAPH_MAX_MATRIX", "500"))
MAX_EDGES = int(os.environ.get("QADGRAPH_MAX_EDGES", "4000"))

STARTED = time.time()
MUL = operator.mul


# --------------------------------------------------------------------------- util
def http_json(url, payload=None, timeout=20, method=None):
    """Appel HTTP JSON vers Qdrant. Retourne (status, data)."""
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method=method or ("POST" if data else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw.decode("utf-8"))
            except Exception:
                return resp.status, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode("utf-8"))
        except Exception:
            return e.code, raw.decode("utf-8", "replace")
    except Exception as e:
        return 0, {"error": str(e)}


def qdrant_get(path, timeout=10):
    return http_json(QDRANT_URL + path, timeout=timeout)


def qdrant_post(path, payload, timeout=60):
    return http_json(QDRANT_URL + path, payload=payload, timeout=timeout)


def normalize(vec):
    """Vecteur unitaire : le cosine devient un simple produit scalaire."""
    if not vec:
        return []
    n = 0.0
    for v in vec:
        n += v * v
    if n <= 0:
        return list(vec)
    inv = 1.0 / (n ** 0.5)
    return [v * inv for v in vec]


def cosine_matrix(vectors):
    """Matrice de similarite cosine, symetrique, diagonale a 1."""
    n = len(vectors)
    mat = [[0.0] * n for _ in range(n)]
    for i in range(n):
        vi = vectors[i]
        mi = mat[i]
        mi[i] = 1.0
        for j in range(i + 1, n):
            v = sum(map(MUL, vi, vectors[j]))
            mi[j] = v
            mat[j][i] = v
    return mat


# --------------------------------------------------------------------------- store
class Store(object):
    """Cache des points, vecteurs, metriques et de la matrice de similarite."""

    def __init__(self):
        self.lock = threading.RLock()
        self.status = "starting"
        self.error = None
        self.version = None
        self.collections = []
        self.collection = None
        self.points = []          # metadonnees legeres
        self.vectors = []         # vecteurs normalises
        self.matrix = None
        self.matrix_ready = False
        self.dims = 0
        self.last_refresh = None
        self.last_refresh_ms = 0
        self.refresh_count = 0
        self._thread = None
        self._running = False

    # -- chargement ---------------------------------------------------------
    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._loop, name="qadgraph-refresh", daemon=True)
        self._thread.start()

    def _loop(self):
        while self._running:
            try:
                self.refresh()
            except Exception as e:                      # pragma: no cover
                with self.lock:
                    self.status = "error"
                    self.error = str(e)
            time.sleep(CACHE_TTL)

    def refresh(self):
        t0 = time.time()
        status, root = qdrant_get("/")
        if status != 200:
            with self.lock:
                self.status = "qdrant-down"
                self.error = (root or {}).get("error", "Qdrant injoignable")
            return False

        # Qdrant 1.x renvoie {"version": "1.19.2"} ; les versions plus
        # anciennes renvoyaient {"version": {"version": "..."}} : on gere les deux.
        ver = (root or {}).get("version")
        version = ver.get("version", "?") if isinstance(ver, dict) else (ver or "?")

        status, cols = qdrant_get("/collections")
        collections = []
        for c in ((cols or {}).get("result") or {}).get("collections", []):
            entry = {"name": c.get("name"), "status": "?"}
            st, det = qdrant_get("/collections/" + urllib.parse.quote(c.get("name", "")))
            if st == 200:
                r = (det or {}).get("result") or {}
                params = (r.get("config") or {}).get("params") or {}
                vecs = params.get("vectors") or {}
                entry.update({
                    "status": r.get("status", "?"),
                    "points": r.get("points_count", 0),
                    "vectors": r.get("vectors_count", r.get("points_count", 0)),
                    "indexed": r.get("indexed_vectors_count", 0),
                    "segments": r.get("segments_count", 0),
                    "dims": vecs.get("size") if isinstance(vecs, dict) else None,
                    "distance": vecs.get("distance") if isinstance(vecs, dict) else None,
                    "optimizer": r.get("optimizer_status", "?"),
                    "payload_schema": (r.get("payload_schema") or {}),
                    "config": r.get("config") or {},
                })
            collections.append(entry)

        target = None
        for c in collections:
            if c.get("name") == COLLECTION:
                target = c
                break
        if target is None and collections:
            target = collections[0]

        points, vectors, dims = [], [], 0
        if target:
            points, vectors, dims = self._scroll(target.get("name"))

        matrix, matrix_ready = None, False
        if vectors and len(vectors) <= MAX_MATRIX_N:
            matrix = cosine_matrix(vectors)
            matrix_ready = True

        with self.lock:
            self.version = version
            self.collections = collections
            self.collection = target
            self.points = points
            self.vectors = vectors
            self.dims = dims
            self.matrix = matrix
            self.matrix_ready = matrix_ready
            self.status = "ok"
            self.error = None
            self.last_refresh = time.time()
            self.last_refresh_ms = int((time.time() - t0) * 1000)
            self.refresh_count += 1
        return True

    def _scroll(self, name, page=500):
        """Recupere tous les points (payload + vecteur) par pagination."""
        out, vectors, offset, dims = [], [], None, 0
        guard = 0
        while guard < 40:
            body = {"limit": page, "with_payload": True, "with_vector": True}
            if offset is not None:
                body["offset"] = offset
            st, data = qdrant_post("/collections/%s/points/scroll" % urllib.parse.quote(name), body, timeout=120)
            if st != 200:
                break
            res = (data or {}).get("result") or {}
            chunk = res.get("points") or []
            for p in chunk:
                pl = p.get("payload") or {}
                vec = p.get("vector")
                if isinstance(vec, dict):
                    vec = list(vec.values())[0] if vec else []
                vec = vec or []
                dims = max(dims, len(vec))
                out.append({
                    "id": str(p.get("id")),
                    "type": str(pl.get("type") or "unknown"),
                    "session": str(pl.get("session_id") or pl.get("session") or ""),
                    "text": str(pl.get("text") or pl.get("summary") or ""),
                    "summary": str(pl.get("summary") or ""),
                    "importance": pl.get("importance"),
                    "status": str(pl.get("status") or ""),
                    "source": str(pl.get("source") or ""),
                    "created": str(pl.get("created") or ""),
                    "payload": pl,
                })
                vectors.append(normalize(vec))
            offset = res.get("next_page_offset")
            guard += 1
            if offset is None:
                break
        return out, vectors, dims

    # -- lectures -----------------------------------------------------------
    def snapshot(self):
        with self.lock:
            return {
                "status": self.status,
                "error": self.error,
                "version": self.version,
                "collections": list(self.collections),
                "collection": dict(self.collection) if self.collection else None,
                "points": list(self.points),
                "vectors": self.vectors,
                "matrix": self.matrix,
                "matrix_ready": self.matrix_ready,
                "dims": self.dims,
                "last_refresh": self.last_refresh,
                "last_refresh_ms": self.last_refresh_ms,
                "refresh_count": self.refresh_count,
            }


STORE = Store()


# --------------------------------------------------------------------------- metriques
def distribution(items, key):
    counts = {}
    for it in items:
        v = it.get(key) or "(none)"
        counts[v] = counts.get(v, 0) + 1
    out = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [{"name": k, "count": v} for k, v in out]


def build_metrics(snap, threshold=0.65):
    points = snap["points"]
    coll = snap["collection"] or {}
    matrix = snap["matrix"]
    n = len(points)

    edges, deg, max_sim, sim_sum, sim_n = 0, [0] * n, 0.0, 0.0, 0
    histogram = [{"bin": "%.2f" % (0.50 + i * 0.05), "count": 0} for i in range(10)]
    if matrix:
        for i in range(n):
            mi = matrix[i]
            for j in range(i + 1, n):
                s = mi[j]
                if s <= 0.5:
                    continue
                if s > max_sim:
                    max_sim = s
                sim_sum += s
                sim_n += 1
                if s >= threshold:
                    edges += 1
                    deg[i] += 1
                    deg[j] += 1
                b = int((s - 0.5) / 0.05)
                if 0 <= b < len(histogram):
                    histogram[b]["count"] += 1

    degrees = sorted((d for d in deg), reverse=True)
    payload_schema = coll.get("payload_schema") or {}
    schema_rows = []
    for field, meta in payload_schema.items():
        schema_rows.append({
            "field": field,
            "data_type": (meta or {}).get("data_type", "?"),
            "points": (meta or {}).get("points", 0),
            "coverage": round(100.0 * (meta or {}).get("points", 0) / n, 1) if n else 0,
        })
    schema_rows.sort(key=lambda r: -r["points"])

    vec_bytes = n * snap["dims"] * 4
    return {
        "status": snap["status"],
        "error": snap["error"],
        "version": snap["version"],
        "last_refresh": snap["last_refresh"],
        "last_refresh_ms": snap["last_refresh_ms"],
        "refresh_count": snap["refresh_count"],
        "uptime_s": int(time.time() - STARTED),
        "collection": {
            "name": coll.get("name"),
            "status": coll.get("status"),
            "points": coll.get("points", n),
            "indexed": coll.get("indexed", 0),
            "segments": coll.get("segments", 0),
            "dims": snap["dims"],
            "distance": coll.get("distance"),
            "optimizer": coll.get("optimizer"),
            "config": coll.get("config") or {},
        },
        "memory": {
            "vector_bytes": vec_bytes,
            "vector_mb": round(vec_bytes / 1048576.0, 2),
            "payload_bytes_est": sum(len(json.dumps(p.get("payload") or {})) for p in points),
        },
        "graph": {
            "threshold": threshold,
            "edges": edges,
            "avg_degree": round(2.0 * edges / n, 2) if n else 0,
            "max_degree": degrees[0] if degrees else 0,
            "median_degree": degrees[len(degrees) // 2] if degrees else 0,
            "isolated": sum(1 for d in deg if d == 0),
            "density": round(2.0 * edges / (n * (n - 1)), 5) if n > 1 else 0,
            "matrix_ready": snap["matrix_ready"],
        },
        "similarity": {
            "max": round(max_sim, 4),
            "mean": round(sim_sum / sim_n, 4) if sim_n else 0,
            "pairs_above_050": sim_n,
            "histogram": histogram,
        },
        "distribution": {
            "type": distribution(points, "type"),
            "session": distribution(points, "session")[:12],
            "status": distribution(points, "status"),
            "source": distribution(points, "source")[:12],
        },
        "payload_schema": schema_rows,
        "collections": snap["collections"],
    }


def build_graph(snap, threshold=0.65, max_edges=MAX_EDGES):
    points = snap["points"]
    matrix = snap["matrix"]
    n = len(points)
    nodes = []
    deg = [0] * n
    edges = []

    if matrix and n:
        pairs = []
        for i in range(n):
            mi = matrix[i]
            for j in range(i + 1, n):
                s = mi[j]
                if s >= threshold:
                    pairs.append((s, i, j))
        pairs.sort(reverse=True)
        for s, i, j in pairs[:max_edges]:
            edges.append({"s": i, "t": j, "v": round(s, 4)})
            deg[i] += 1
            deg[j] += 1

    for i, p in enumerate(points):
        nodes.append({
            "i": i,
            "id": p["id"],
            "type": p["type"],
            "session": p["session"],
            "text": p["text"][:180],
            "importance": p["importance"],
            "status": p["status"],
            "source": p["source"],
            "created": p["created"],
            "d": deg[i],
        })
    return {
        "nodes": nodes,
        "edges": edges,
        "threshold": threshold,
        "total_edges_above": sum(1 for i in range(n) for j in range(i + 1, n)
                                 if matrix and matrix[i][j] >= threshold) if matrix else 0,
        "matrix_ready": snap["matrix_ready"],
    }


def neighbors_of(snap, idx, k=8):
    matrix = snap["matrix"]
    points = snap["points"]
    if not matrix or idx >= len(points):
        return []
    row = matrix[idx]
    scored = [(row[j], j) for j in range(len(points)) if j != idx]
    scored.sort(reverse=True)
    out = []
    for s, j in scored[:k]:
        p = points[j]
        out.append({"id": p["id"], "type": p["type"], "session": p["session"],
                    "text": p["text"][:220], "score": round(s, 4), "index": j})
    return out


def search_points(snap, query, limit=8, min_score=0.0):
    points = snap["points"]
    matrix = snap["matrix"]
    q = query.strip().lower()
    if not q:
        return []
    if matrix:
        # le vecteur de la requete n existe pas : on classe sur le texte
        # puis on repond par cosine des voisins de chaque candidat.
        cands = [i for i, p in enumerate(points) if q in p["text"].lower()
                 or q in p["session"].lower() or q in p["type"].lower()]
        if not cands:
            cands = list(range(len(points)))
        results = []
        for i in cands[:400]:
            for nb in neighbors_of(snap, i, 3):
                results.append(nb)
        seen, uniq = set(), []
        for r in sorted(results, key=lambda r: -r["score"]):
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            uniq.append(r)
        return uniq[:limit]
    out = []
    for p in points:
        hay = (p["text"] + " " + p["type"] + " " + p["session"]).lower()
        if q in hay:
            out.append({"id": p["id"], "type": p["type"], "session": p["session"],
                        "text": p["text"][:220], "score": 0.0, "index": -1})
    return out[:limit]


def read_tail(path, tail=120):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            block = min(size, 200000)
            fh.seek(size - block)
            raw = fh.read(block).decode("utf-8", "replace")
    except Exception as e:
        return {"error": str(e), "lines": []}
    lines = [l for l in raw.splitlines() if l.strip()]
    return {"lines": lines[-tail:], "path": str(path)}


# --------------------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    server_version = "QadGraph/2.0"

    # -- helpers
    def _send(self, code, body, ctype="application/json; charset=utf-8", cache=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False, default=str).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if cache:
            self.send_header("Cache-Control", cache)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError):
            pass

    def _file(self, name, ctype):
        p = (WEB / name).resolve()
        try:
            p.relative_to(WEB.resolve())
        except ValueError:
            return self._send(403, {"error": "forbidden"})
        if not p.is_file():
            return self._send(404, {"error": "not found"})
        return self._send(200, p.read_bytes(), ctype, cache="no-cache")

    def _query(self):
        parsed = urllib.parse.urlparse(self.path)
        return parsed.path, urllib.parse.parse_qs(parsed.query)

    def log_message(self, fmt, *args):
        pass

    # -- verbs
    def do_OPTIONS(self):
        self._send(204, b"", "text/plain")

    def do_GET(self):
        path, q = self._query()
        try:
            if path in ("/", "/index.html"):
                return self._file("index.html", "text/html; charset=utf-8")
            if path == "/assets/styles.css":
                return self._file("styles.css", "text/css; charset=utf-8")
            if path == "/assets/app.js":
                return self._file("app.js", "application/javascript; charset=utf-8")
            if path == "/favicon.ico":
                return self._send(200, b"", "image/x-icon")

            if path == "/api/health":
                snap = STORE.snapshot()
                return self._send(200, {
                    "dashboard": "ok",
                    "qdrant": "up" if snap["status"] == "ok" else "down",
                    "qdrant_status": snap["status"],
                    "error": snap["error"],
                    "version": snap["version"],
                    "collection": COLLECTION,
                    "uptime_s": int(time.time() - STARTED),
                    "last_refresh_ms": snap["last_refresh_ms"],
                })

            if path == "/api/collections":
                snap = STORE.snapshot()
                return self._send(200, {"collections": snap["collections"],
                                        "qdrant_version": snap["version"]})

            if path.startswith("/api/collection/"):
                name = urllib.parse.unquote(path[len("/api/collection/"):])
                snap = STORE.snapshot()
                for c in snap["collections"]:
                    if c.get("name") == name:
                        return self._send(200, c)
                return self._send(404, {"error": "collection inconnue", "name": name})

            if path == "/api/graph":
                thr = float((q.get("threshold") or ["0.65"])[0])
                snap = STORE.snapshot()
                return self._send(200, build_graph(snap, thr))

            if path == "/api/node":
                idx = int((q.get("index") or ["-1"])[0])
                snap = STORE.snapshot()
                if idx < 0 or idx >= len(snap["points"]):
                    return self._send(404, {"error": "index hors bornes"})
                p = dict(snap["points"][idx])
                p["index"] = idx
                p["neighbors"] = neighbors_of(snap, idx, 8)
                return self._send(200, p)

            if path == "/api/search":
                query = (q.get("q") or [""])[0]
                limit = int((q.get("limit") or ["8"])[0])
                snap = STORE.snapshot()
                return self._send(200, {"query": query, "results": search_points(snap, query, limit),
                                        "method": "texte + cosine local"})

            if path == "/api/metrics":
                thr = float((q.get("threshold") or ["0.65"])[0])
                return self._send(200, build_metrics(STORE.snapshot(), thr))

            if path == "/api/recent":
                limit = int((q.get("limit") or ["12"])[0])
                snap = STORE.snapshot()
                pts = sorted(snap["points"],
                             key=lambda p: (p.get("importance") or 0, p.get("created") or ""),
                             reverse=True)[:limit]
                return self._send(200, {"points": pts})

            if path == "/api/logs":
                tail = int((q.get("tail") or ["120"])[0])
                stream = (q.get("stream") or ["stdout"])[0]
                name = "qdrant.stderr.log" if stream == "stderr" else "qdrant.stdout.log"
                return self._send(200, read_tail(LOGS_DIR / name, tail))

            if path == "/api/config":
                cfg = ""
                cfg_path = QDRANT_DIR / "config" / "config.yaml"
                try:
                    cfg = cfg_path.read_text(encoding="utf-8", errors="replace")
                except Exception:
                    cfg = "# config.yaml introuvable : " + str(cfg_path)
                mcp_cfg = json.dumps({
                    "mcpServers": {
                        "qadgraph": {
                            "command": r"C:\AI\EmbeddingDB\.venv\Scripts\python.exe",
                            "args": [str(ROOT / "mcp" / "qadgraph_mcp.py")],
                            "env": {"QADGRAPH_QDRANT": QDRANT_URL,
                                    "QADGRAPH_COLLECTION": COLLECTION}
                        }
                    }
                }, indent=2)
                return self._send(200, {
                    "qdrant_config_path": str(cfg_path),
                    "qdrant_config": cfg,
                    "mcp_config": mcp_cfg,
                    "server": {
                        "qdrant_url": QDRANT_URL,
                        "collection": COLLECTION,
                        "host": HOST,
                        "port": PORT,
                        "root": str(ROOT),
                        "cache_ttl_s": CACHE_TTL,
                        "max_matrix_n": MAX_MATRIX_N,
                    },
                })

            if path == "/api/qdrant/proxy":
                target = (q.get("path") or ["/"])[0]
                status, data = qdrant_get(target)
                return self._send(status if status else 502, data)

            if path == "/api/refresh":
                ok = STORE.refresh()
                return self._send(200 if ok else 503, {"refreshed": ok,
                                                        "status": STORE.status})

            return self._send(404, {"error": "route inconnue", "path": path})
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def do_POST(self):
        path, q = self._query()
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                body = {}
            if path == "/api/qdrant/proxy":
                target = body.get("path") or (q.get("path") or ["/"])[0]
                payload = body.get("body", body)
                if "path" in payload:
                    payload = dict(payload)
                    payload.pop("path", None)
                status, data = qdrant_post(target, payload)
                return self._send(status if status else 502, data)
            if path == "/api/refresh":
                ok = STORE.refresh()
                return self._send(200 if ok else 503, {"refreshed": ok})
            return self._send(404, {"error": "route inconnue", "path": path})
        except Exception as e:
            return self._send(500, {"error": str(e)})


def main():
    if not WEB.is_dir():
        print("ERREUR : dossier web introuvable : %s" % WEB, file=sys.stderr)
        sys.exit(1)
    STORE.start()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    print("QadGraph  ->  http://%s:%d/" % (HOST, PORT))
    print("Qdrant    ->  %s" % QDRANT_URL)
    print("Collection->  %s" % COLLECTION)
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
