#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QadGraph — serveur MCP : expose les metriques Qdrant a N'IMPORTE QUEL client MCP
(Mavis, Claude Desktop, Mavis Code, kimi, Codex, ...).

Installation (une fois) : coller ce JSON dans la config MCP de votre client.

    {
      "mcpServers": {
        "qadgraph": {
          "command": "C:\\AI\\EmbeddingDB\\.venv\\Scripts\\python.exe",
          "args": ["C:\\AI\\EmbeddingDB\\migration-qdrant\\qadgraph\\mcp\\qadgraph_mcp.py"],
          "env": {
            "QADGRAPH_QDRANT": "http://127.0.0.1:6333",
            "QADGRAPH_COLLECTION": "hermes_qwen3_memory"
          }
        }
      }
    }

Le serveur est adaptatif : tout se regle par variables d'environnement
(QADGRAPH_QDRANT, QADGRAPH_COLLECTION, QADGRAPH_DASHBOARD, QADGRAPH_CACHE_TTL).
Il interroge Qdrant en direct et calcule les memes metriques que le dashboard.

Outils exposes
--------------
qadgraph_status        etat du serveur, de Qdrant et de la collection
qadgraph_metrics      tableau de bord complet (graphe, distributions, schema)
qadgraph_collections  toutes les collections avec leurs metriques
qadgraph_search       recherche cosine dans la memoire vectorielle
qadgraph_recent       entrees recentes
qadgraph_topology     statistiques de graphe + noeuds les plus connectes
qadgraph_point        payload complet d'un point + ses voisins proches
qadgraph_logs         queue recente des journaux Qdrant
qadgraph_dashboard    URL du dashboard et rappel des commandes
"""
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

# --- chargement du moteur partage (server.py) sans collision de noms ---------
_spec = importlib.util.spec_from_file_location("qadgraph_engine", ROOT / "server.py")
_engine = importlib.util.module_from_spec(_spec)
sys.modules["qadgraph_engine"] = _engine
_spec.loader.exec_module(_engine)

Store = _engine.Store
build_metrics = _engine.build_metrics
build_graph = _engine.build_graph
neighbors_of = _engine.neighbors_of
search_points = _engine.search_points
read_tail = _engine.read_tail
LOGS_DIR = _engine.LOGS_DIR
COLLECTION = _engine.COLLECTION
QDRANT_URL = _engine.QDRANT_URL
DASHBOARD_URL = os.environ.get(
    "QADGRAPH_DASHBOARD", "http://127.0.0.1:%d/" % _engine.PORT
)

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "ERREUR : le module 'mcp' est introuvable.\n"
        "Lancez ce serveur avec le venv qui contient FastMCP :\n"
        r"  C:\AI\EmbeddingDB\.venv\Scripts\python.exe" + " " + str(Path(__file__)) + "\n"
    )
    raise SystemExit(2)

mcp = FastMCP("qadgraph")
STORE = Store()


def _snap():
    return STORE.snapshot()


def _ensure(force=False):
    """Le cache est rafraichi en arriere-plan ; on attend qu'il soit pret."""
    deadline = time.time() + 20
    while time.time() < deadline:
        snap = _snap()
        if snap["status"] == "ok" and (force or snap["points"]):
            return snap
        if snap["status"] == "qdrant-down" or snap["status"] == "error":
            break
        time.sleep(0.4)
    return _snap()


# --------------------------------------------------------------------------- outils
@mcp.tool()
def qadgraph_status() -> dict:
    """Etat du dashboard QadGraph, de Qdrant et de la collection memoire."""
    snap = _ensure()
    coll = snap["collection"] or {}
    return {
        "dashboard": "ok",
        "qdrant_url": QDRANT_URL,
        "qdrant_version": snap["version"],
        "qdrant_status": snap["status"],
        "error": snap["error"],
        "collection": coll.get("name"),
        "points": coll.get("points", len(snap["points"])),
        "dimensions": snap["dims"],
        "distance": coll.get("distance"),
        "indexed_vectors": coll.get("indexed"),
        "segments": coll.get("segments"),
        "optimizer_status": coll.get("optimizer"),
        "last_refresh_ms": snap["last_refresh_ms"],
        "dashboard_url": DASHBOARD_URL,
    }


@mcp.tool()
def qadgraph_metrics(threshold: float = 0.65) -> dict:
    """Tableau de bord de metriques Qdrant : graphe de similarite, distributions, schema de payload."""
    snap = _ensure()
    return build_metrics(snap, threshold)


@mcp.tool()
def qadgraph_collections() -> dict:
    """Liste de toutes les collections Qdrant avec points, segments, dimensions et statut."""
    snap = _ensure()
    return {"qdrant_version": snap["version"], "collections": snap["collections"]}


@mcp.tool()
def qadgraph_search(query: str, limit: int = 8) -> dict:
    """Recherche dans la memoire vectorielle : renvoie les points les plus proches de la requete."""
    snap = _ensure()
    results = search_points(snap, query, limit)
    return {
        "query": query,
        "count": len(results),
        "method": "similarite cosine locale sur les vecteurs normalises",
        "results": results,
    }


@mcp.tool()
def qadgraph_recent(limit: int = 10) -> dict:
    """Entrees les plus recentes (triees par importance puis date de creation)."""
    snap = _ensure()
    pts = sorted(snap["points"],
                 key=lambda p: (p.get("importance") or 0, p.get("created") or ""),
                 reverse=True)[:limit]
    return {"count": len(pts), "points": pts}


@mcp.tool()
def qadgraph_topology(threshold: float = 0.65, top: int = 10) -> dict:
    """Statistiques du graphe de similarite et noeuds les plus connectes."""
    snap = _ensure()
    graph = build_graph(snap, threshold)
    deg = {}
    for e in graph["edges"]:
        deg[e["s"]] = deg.get(e["s"], 0) + 1
        deg[e["t"]] = deg.get(e["t"], 0) + 1
    ranked = sorted(graph["nodes"], key=lambda n: -deg.get(n["i"], 0))[:top]
    return {
        "threshold": threshold,
        "nodes": len(graph["nodes"]),
        "edges": len(graph["edges"]),
        "matrix_ready": graph["matrix_ready"],
        "most_connected": [
            {"id": n["id"], "type": n["type"], "degree": deg.get(n["i"], 0), "text": n["text"][:160]}
            for n in ranked
        ],
    }


@mcp.tool()
def qadgraph_point(point_id: str) -> dict:
    """Payload complet d'un point + ses voisins les plus similaires."""
    snap = _ensure()
    for i, p in enumerate(snap["points"]):
        if p["id"] == point_id:
            out = dict(p)
            out["neighbors"] = neighbors_of(snap, i, 8)
            return out
    return {"error": "point introuvable", "id": point_id}


@mcp.tool()
def qadgraph_logs(tail: int = 60, stream: str = "stdout") -> dict:
    """Dernieres lignes des journaux Qdrant sur disque."""
    name = "qdrant.stderr.log" if stream == "stderr" else "qdrant.stdout.log"
    return read_tail(LOGS_DIR / name, tail)


@mcp.tool()
def qadgraph_dashboard() -> dict:
    """URL du dashboard QadGraph et commandes de demarrage."""
    return {
        "dashboard_url": DASHBOARD_URL,
        "server_command": r"C:\AI\EmbeddingDB\.venv\Scripts\python.exe C:\AI\EmbeddingDB\migration-qdrant\qadgraph\server.py",
        "views": ["Vector Topology", "Collections", "Similarity Search", "Metrics", "Logs", "Config"],
        "auto_refresh_seconds": 15,
        "notes": "Le dashboard lit Qdrant en direct et calcule la similarite cosine cote serveur.",
    }


if __name__ == "__main__":
    STORE.start()
    mcp.run()
