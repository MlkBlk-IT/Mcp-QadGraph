> ⚠️ **Note:** The rest of this repository (code, comments, scripts, docs, commits, issues) is written in **French**. Only this README is in English.

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:e10600,50:1a0505,100:00ff9c&height=140&section=header&text=Mcp-QadGraph&fontSize=42&fontColor=e10600&fontAlignY=32&desc=Qdrant%20control%20plane%20%E2%80%94%203D%20similarity%20dashboard%20%2B%20read-only%20MCP%20server&descAlignY=53&descSize=15&descColor=00ff9c" width="100%" alt="Mcp-QadGraph" />

<img src="https://img.shields.io/badge/JavaScript-f7df1e?style=for-the-badge&logo=javascript&logoColor=0d0d0d&labelColor=0d0d0d" /> <img src="https://img.shields.io/badge/Python%20stdlib-3776ab?style=for-the-badge&logo=python&logoColor=white&labelColor=0d0d0d" /> <img src="https://img.shields.io/badge/Qdrant-e10600?style=for-the-badge&labelColor=0d0d0d" /> <img src="https://img.shields.io/badge/100%25%20local%20%C2%B7%200%20paid%20API%20%C2%B7%200%20Docker-00ff9c?style=for-the-badge&labelColor=0d0d0d" />

</div>

> **"See the vector memory, don't just query it."**
> Local dashboard (3D similarity sphere) + MCP server for a [Qdrant](https://qdrant.tech) database.
> Python **stdlib** on the server side · 100% local · 0 paid API · 0 Docker.

---

## The problem

A Qdrant collection is thousands of unreadable vectors. The native UI shows the neighborhood
of one point, not the **global shape** of the memory: duplicates, clusters, hub nodes, type
distribution.

QadGraph computes cosine similarity **server-side**, caches the result, and serves:

- a **dashboard** (3D graph, metrics, search, logs, config);
- an **MCP server**: any agent (Claude Desktop, Codex, kimi…) inspects the memory read-only.

---

## Current state

**v0.1.1 — working on local Qdrant, not yet generalized. Security fixes (CORS, proxy, SSRF).**

- Verified at runtime (2026-10-22, Windows, Python 3.14, Qdrant 1.19.2): all 9 main dashboard routes answer `200`, `/api/health` returns `qdrant: up`.
- **Automated tests limited to dashboard security**: `tests/test_security.py` (stdlib, without Qdrant); `python -m unittest discover -s tests -v`.
- **No performance benchmark**: cosine computation is pure Python, O(n²·dimension), therefore capped (see Limitations).
- Only tested on Windows. Linux/macOS support is unverified.
- Coupled to Qdrant and to an agent memory's payload schema (`type`, `session`, `text`/`summary` fields). See *Known limitations*.

---

## Quick start

Prerequisites: Qdrant running on `http://127.0.0.1:6333`, Python 3.8+ advertised (tested on 3.14).

```powershell
git clone https://github.com/MlkBlk-IT/Mcp-QadGraph
cd Mcp-QadGraph
$env:QADGRAPH_COLLECTION = "my_collection"
python qadgraph\server.py        # → http://127.0.0.1:8766/
```

The dashboard has **zero dependencies** to install. The frontend loads D3 from a CDN: internet is required for the graph view.

### MCP server

```json
{
  "mcpServers": {
    "qadgraph": {
      "command": "<PYTHON_WITH_MCP>",
      "args": ["<REPO_PATH>/qadgraph/mcp/qadgraph_mcp.py"],
      "env": {
        "QADGRAPH_QDRANT": "http://127.0.0.1:6333",
        "QADGRAPH_COLLECTION": "my_collection"
      }
    }
  }
}
```

The MCP server requires the `mcp` package (FastMCP): `pip install -r requirements.txt` in the Python used.

---

## Architecture

```
MCP client / browser
   │                         │
   ▼                         ▼
qadgraph/mcp/qadgraph_mcp.py     qadgraph/web/  (3D UI, app.js)
   │  imports                     │  HTTP
   ▼                              ▼
qadgraph/server.py   ← Store + cache + server-side cosine + HTTP API (:8766)
   │  HTTP JSON
   ▼
Qdrant (:6333)  — /collections, points/scroll
```

The browser receives a lightweight topology (nodes + edges), never the raw vectors.

| File | Role |
|------|------|
| `qadgraph/server.py` | Engine (Store, cache, similarity, metrics) + stdlib HTTP server |
| `qadgraph/mcp/qadgraph_mcp.py` | FastMCP server, 9 tools, reuses the `server.py` engine |
| `qadgraph/web/` | Frontend: `index.html`, `app.js`, `styles.css` |
| `docs/REFERENCE.md` | Detailed reference: routes, variables, navigation gestures |
| `PROGRESS.md` | Build journal |

---

## Exposed MCP tools (9)

| Tool | Role |
|-------|------|
| `qadgraph_status` | Server, Qdrant and collection status |
| `qadgraph_metrics` | Full metrics (graph, distributions, schema) |
| `qadgraph_collections` | All collections + metrics |
| `qadgraph_search` | Cosine search across the memory |
| `qadgraph_recent` | Recent entries |
| `qadgraph_topology` | Graph stats + most connected nodes |
| `qadgraph_point` | Full payload of a point + 8 nearest neighbors |
| `qadgraph_logs` | Qdrant log queue |
| `qadgraph_dashboard` | Dashboard URL and startup commands |

All tools are **read-only**.

---

## Configuration (environment variables)

| Variable | Default | Role |
|----------|---------|------|
| `QADGRAPH_QDRANT` | `http://127.0.0.1:6333` | Qdrant URL |
| `QADGRAPH_COLLECTION` | `hermes_qwen3_memory` | Collection analyzed (**change this**) |
| `QADGRAPH_HOST` | `127.0.0.1` | Listen interface |
| `QADGRAPH_PORT` | `8766` | Dashboard port |
| `QADGRAPH_CACHE_TTL` | `45` | Seconds between two refreshes |
| `QADGRAPH_MAX_MATRIX` | `500` | Max similarity matrix size |
| `QADGRAPH_MAX_EDGES` | `4000` | Max edges returned |
| `QADGRAPH_DASHBOARD` | `http://127.0.0.1:8766/` | URL announced by the MCP |
| `QADGRAPH_ALLOWED_HOSTS` | *(empty)* | Extra hosts accepted in the `Host` header (e.g. `mypc:8766`) |

---

## Known limitations

**Security**

- **Fixed in v0.1.1 — CORS / CSRF / DNS rebinding.** The server no longer sends `Access-Control-Allow-Origin: *`, and rejects (`403`) any request whose `Host` or `Origin` is not the dashboard's (`127.0.0.1`, `localhost`, `[::1]` + port, plus `QADGRAPH_ALLOWED_HOSTS`). `OPTIONS` preflights are refused (`405`).
- **Fixed in v0.1.1 — read-only proxy.** `POST /api/qdrant/proxy` only accepts `search`, `scroll`, `count`, `query`, `recommend`, `discover` and `facet`. Before the fix, a `POST` to `/collections/<name>/points/delete` was relayed to Qdrant (reproduced by a test).
- **Fixed in v0.1.1 — proxy paths.** Paths must be relative (`/...`): no more `@host`, `//host` or `..`.
- **Still open:** no authentication; `/api/config` returns Qdrant's `config.yaml` if it exists (it may contain an API key) to any local process reaching the port. **Do not run with `QADGRAPH_HOST` other than `127.0.0.1`.**

**Functional**

- **Qdrant only.** The coupling lives in `Store.refresh`, `Store._scroll` and `qadgraph_logs`, but no other backend is implemented.
- **Expected payload schema**: `type`, `session`, `text` (or `summary`). On another collection, these fields will be `unknown` / empty.
- Similarity matrix capped at `QADGRAPH_MAX_MATRIX` points (500); beyond that, only point metrics remain available. Pure-Python computation: CPU-bound.
- Logs (`/api/logs`, `qadgraph_logs`) read `logs/qdrant.stdout.log` and `logs/qdrant.stderr.log` **at the repo root**. Absent by default: the Logs view will be empty.
- Some config examples (MCP docstring, `qadgraph-mcp.json`, `/api/config`, `docs/REFERENCE.md`, `PROGRESS.md`) contain **the author's Windows paths** (`C:\AI\EmbeddingDB\...`): adapt them. The code itself resolves its paths via `__file__`.
- No CI, no authentication, no functional tests outside security.

---

## Methodology

- **Read-only**: the MCP never writes to Qdrant.
- **Server-side computation**: the browser receives ~40 KB of topology, not 6 MB of vectors.
- **stdlib only** for the dashboard: starts under any Python with no installation.
- **Portable by construction**: no proprietary SDK, no paid API, 100% CPU.

---

## Author

**Malik** — IT Support student (DEP), self-taught
Focus: Sysadmin + Cyber + AI + Cloud

---

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:00ff9c,50:03150c,100:e10600&height=100&section=footer" width="100%" alt="" />

**⚡ Built on CPU. Proven on disk. ⚡**

</div>
