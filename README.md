# 🕸️ QadGraph — Plan de contrôle Qdrant

> **« Voir la mémoire vectorielle, pas seulement l'interroger. »**
> Dashboard local (sphère 3D de similarité) + serveur MCP pour une base [Qdrant](https://qdrant.tech).
> Python **stdlib** côté serveur · 100 % local · 0 API payante · 0 Docker.

---

## Le problème

Une collection Qdrant, c'est des milliers de vecteurs illisibles. L'UI native montre le voisinage d'un
point, pas la **forme globale** de la mémoire : doublons, clusters, nœuds-hubs, distribution des types.

QadGraph calcule la similarité cosine **côté serveur**, met le résultat en cache, et sert :

- un **dashboard** (graphe 3D, métriques, recherche, logs, config) ;
- un **serveur MCP** : n'importe quel agent (Claude Desktop, Codex, kimi…) inspecte la mémoire en lecture seule.

---

## État actuel

**v0.1.1 — fonctionnel sur Qdrant local, pas encore généralisé. Correctif de sécurité (CORS, proxy, SSRF).**

- Vérifié à l'exécution (2026-10-22, Windows, Python 3.14, Qdrant 1.19.2) : les 9 routes principales du dashboard répondent `200`, `/api/health` renvoie `qdrant: up`.
- **Tests automatisés limités à la sécurité du dashboard** : `tests/test_security.py` (stdlib, sans Qdrant) ; `python -m unittest discover -s tests -v`.
- **Pas de benchmark de performance** : le calcul cosine est en Python pur, O(n²·dimension), donc plafonné (voir Limites).
- Testé uniquement sur Windows. Le support Linux/macOS n'est pas vérifié.
- Couplé à Qdrant et au schéma de payload de la mémoire d'un agent (champs `type`, `session`, `text`/`summary`). Voir *Limites connues*.

---

## Démarrage rapide

Prérequis : Qdrant qui tourne sur `http://127.0.0.1:6333`, Python 3.8+ annoncé (testé sur 3.14).

```powershell
git clone https://github.com/MlkBlk-IT/Mcp-QadGraph
cd Mcp-QadGraph
$env:QADGRAPH_COLLECTION = "ma_collection"
python qadgraph\server.py        # → http://127.0.0.1:8766/
```

Le dashboard n'a **aucune dépendance** à installer. Le front charge D3 depuis un CDN : internet requis pour la vue graphe.

### Serveur MCP

```json
{
  "mcpServers": {
    "qadgraph": {
      "command": "<PYTHON_AVEC_MCP>",
      "args": ["<CHEMIN_DU_DEPOT>/qadgraph/mcp/qadgraph_mcp.py"],
      "env": {
        "QADGRAPH_QDRANT": "http://127.0.0.1:6333",
        "QADGRAPH_COLLECTION": "ma_collection"
      }
    }
  }
}
```

Le serveur MCP nécessite le paquet `mcp` (FastMCP) : `pip install -r requirements.txt` dans le Python utilisé.

---

## Architecture

```
Client MCP / navigateur
   │                         │
   ▼                         ▼
qadgraph/mcp/qadgraph_mcp.py     qadgraph/web/  (UI 3D, app.js)
   │  importe                       │  HTTP
   ▼                                ▼
qadgraph/server.py   ← Store + cache + cosine côté serveur + API HTTP (:8766)
   │  HTTP JSON
   ▼
Qdrant (:6333)  — /collections, points/scroll
```

Le navigateur reçoit une topologie légère (nœuds + arêtes), jamais les vecteurs bruts.

| Fichier | Rôle |
|---------|------|
| `qadgraph/server.py` | Moteur (Store, cache, similarité, métriques) + serveur HTTP stdlib |
| `qadgraph/mcp/qadgraph_mcp.py` | Serveur FastMCP, 9 outils, réutilise le moteur de `server.py` |
| `qadgraph/web/` | Front : `index.html`, `app.js`, `styles.css` |
| `docs/REFERENCE.md` | Référence détaillée : routes, variables, gestes de navigation |
| `PROGRESS.md` | Journal de chantier |

---

## Outils MCP exposés (9)

| Outil | Rôle |
|-------|------|
| `qadgraph_status` | État du serveur, de Qdrant et de la collection |
| `qadgraph_metrics` | Métriques complètes (graphe, distributions, schéma) |
| `qadgraph_collections` | Toutes les collections + métriques |
| `qadgraph_search` | Recherche cosine dans la mémoire |
| `qadgraph_recent` | Entrées récentes |
| `qadgraph_topology` | Stats du graphe + nœuds les plus connectés |
| `qadgraph_point` | Payload complet d'un point + 8 voisins proches |
| `qadgraph_logs` | Queue des journaux Qdrant |
| `qadgraph_dashboard` | URL du dashboard et commandes de démarrage |

Tous les outils sont en **lecture seule**.

---

## Configuration (variables d'environnement)

| Variable | Défaut | Rôle |
|----------|--------|------|
| `QADGRAPH_QDRANT` | `http://127.0.0.1:6333` | URL de Qdrant |
| `QADGRAPH_COLLECTION` | `hermes_qwen3_memory` | Collection analysée (**à changer**) |
| `QADGRAPH_HOST` | `127.0.0.1` | Interface d'écoute |
| `QADGRAPH_PORT` | `8766` | Port du dashboard |
| `QADGRAPH_CACHE_TTL` | `45` | Secondes entre deux rafraîchissements |
| `QADGRAPH_MAX_MATRIX` | `500` | Taille max de la matrice de similarité |
| `QADGRAPH_MAX_EDGES` | `4000` | Arêtes max renvoyées |
| `QADGRAPH_DASHBOARD` | `http://127.0.0.1:8766/` | URL annoncée par le MCP |
| `QADGRAPH_ALLOWED_HOSTS` | *(vide)* | Hôtes supplémentaires acceptés dans l'en-tête `Host` (ex. `monpc:8766`) |

---

## Limites connues

**Sécurité**

- **Corrigé en v0.1.1 — CORS / CSRF / DNS rebinding.** Le serveur n'envoie plus `Access-Control-Allow-Origin: *`, et refuse (`403`) toute requête dont le `Host` ou l'`Origin` n'est pas celui du dashboard (`127.0.0.1`, `localhost`, `[::1]` + le port, plus `QADGRAPH_ALLOWED_HOSTS`). Les preflights `OPTIONS` sont refusés (`405`).
- **Corrigé en v0.1.1 — proxy en lecture seule.** `POST /api/qdrant/proxy` n'accepte que `search`, `scroll`, `count`, `query`, `recommend`, `discover` et `facet`. Avant le correctif, un `POST` vers `/collections/<nom>/points/delete` était relayé à Qdrant (reproduit par un test).
- **Corrigé en v0.1.1 — chemins du proxy.** Les chemins doivent être relatifs (`/...`) : plus de `@hote`, `//hote` ni `..`.
- **Reste ouvert :** aucune authentification ; `/api/config` renvoie le `config.yaml` de Qdrant s'il existe (il peut contenir une clé API) à tout processus local qui atteint le port. **Ne pas lancer avec `QADGRAPH_HOST` autre que `127.0.0.1`.**

**Fonctionnel**

- **Qdrant uniquement.** Le couplage est localisé dans `Store.refresh`, `Store._scroll` et `qadgraph_logs`, mais aucun autre backend n'est implémenté.
- **Schéma de payload attendu** : `type`, `session`, `text` (ou `summary`). Sur une autre collection, ces champs seront `unknown` / vides.
- Matrice de similarité plafonnée à `QADGRAPH_MAX_MATRIX` points (500) ; au-delà, seules les métriques ponctuelles restent disponibles. Calcul en Python pur : CPU-bound.
- Les logs (`/api/logs`, `qadgraph_logs`) lisent `logs/qdrant.stdout.log` et `logs/qdrant.stderr.log` **à la racine du dépôt**. Absents par défaut : la vue Logs sera vide.
- Des exemples de configuration (docstring du MCP, `qadgraph-mcp.json`, `/api/config`, `docs/REFERENCE.md`, `PROGRESS.md`) contiennent des **chemins Windows de l'auteur** (`C:\AI\EmbeddingDB\...`) : à adapter. Le code, lui, résout ses chemins via `__file__`.
- Pas de CI, pas d'authentification, pas de tests fonctionnels hors sécurité.

---

## Méthodologie

- **Lecture seule** : le MCP n'écrit jamais dans Qdrant.
- **Calcul côté serveur** : le navigateur reçoit ~40 Ko de topologie, pas 6 Mo de vecteurs.
- **stdlib only** pour le dashboard : démarre sous n'importe quel Python sans installation.
- **Portable par construction** : aucun SDK propriétaire, aucune API payante, 100 % CPU.

---

## Auteur

**Malik** — étudiant DEP Soutien Informatique, autodidacte
Spécialisation : Sysadmin + Cyber + AI + Cloud
