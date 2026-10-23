# QadGraph — Qdrant Control Plane

Dashboard local + serveur MCP pour la mémoire vectorielle Qdrant.
Windows natif, sans Docker, **stdlib only** côté serveur.

```
http://127.0.0.1:8766/
```

---

## Démarrage

```powershell
# dashboard (fonctionne avec n'importe quel Python 3.8+)
C:\Python314\python.exe -u C:\AI\EmbeddingDB\migration-qdrant\dashboard\server.py

# ou directement le serveur du dossier dédié
C:\Python314\python.exe -u C:\AI\EmbeddingDB\migration-qdrant\qadgraph\server.py
```

Qdrant doit tourner sur `http://127.0.0.1:6333`
(le tray `scripts\qdrant_tray.ps1` s'en charge et surveille).

Le chemin `dashboard\server.py` est conservé : c'est **l'entrée de la tâche
planifiée** `Hermes Qdrant Tray`. Ce fichier délègue au serveur du dossier
`qadgraph\`, donc ni le lien ni l'automatisme ne sont cassés.

---

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `QADGRAPH_QDRANT` | `http://127.0.0.1:6333` | URL de Qdrant |
| `QADGRAPH_COLLECTION` | `hermes_qwen3_memory` | collection analysée |
| `QADGRAPH_HOST` | `127.0.0.1` | interface d'écoute |
| `QADGRAPH_PORT` | `8766` | port du dashboard |
| `QADGRAPH_CACHE_TTL` | `45` | secondes entre deux rafraîchissements du cache |
| `QADGRAPH_MAX_MATRIX` | `500` | taille max de la matrice de similarité complète |
| `QADGRAPH_MAX_EDGES` | `4000` | nombre max d'arêtes renvoyées |
| `QADGRAPH_DASHBOARD` | `http://127.0.0.1:8766/` | URL annoncée par le MCP |

---

## API HTTP

| Route | Méthode | Retour |
|---|---|---|
| `/` | GET | le dashboard |
| `/assets/styles.css`, `/assets/app.js` | GET | ressources statiques |
| `/api/health` | GET | état dashboard + Qdrant |
| `/api/collections` | GET | toutes les collections + métriques |
| `/api/collection/<nom>` | GET | détail d'une collection |
| `/api/metrics?threshold=` | GET | métriques agrégées (graphe, distributions, schéma) |
| `/api/graph?threshold=` | GET | nœuds + arêtes au seuil demandé |
| `/api/node?index=` | GET | payload complet + 8 voisins |
| `/api/search?q=&limit=` | GET | recherche cosine |
| `/api/recent?limit=` | GET | entrées récentes |
| `/api/logs?tail=&stream=` | GET | journaux Qdrant (`stdout` / `stderr`) |
| `/api/config` | GET | config Qdrant + config serveur + config MCP |
| `/api/refresh` | GET/POST | force un rechargement du cache |
| `/api/qdrant/proxy?path=` | GET | proxy vers Qdrant |
| `/api/qdrant/proxy` | POST | proxy POST (`{path, body}`) |

---

## Serveur MCP

Le serveur expose les métriques Qdrant à **n'importe quel client MCP**
(Mavis, Claude Desktop, kimi, Codex…).

### Installation

Coller ce bloc dans la configuration MCP du client :

```json
{
  "mcpServers": {
    "qadgraph": {
      "command": "C:\\AI\\EmbeddingDB\\.venv\\Scripts\\python.exe",
      "args": [
        "C:\\AI\\EmbeddingDB\\migration-qdrant\\qadgraph\\mcp\\qadgraph_mcp.py"
      ],
      "env": {
        "QADGRAPH_QDRANT": "http://127.0.0.1:6333",
        "QADGRAPH_COLLECTION": "hermes_qwen3_memory",
        "QADGRAPH_DASHBOARD": "http://127.0.0.1:8766/"
      }
    }
  }
}
```

Fichier prêt à copier : `mcp\qadgraph-mcp.json`.
La vue **Config** du dashboard expose la même config, avec un bouton de copie
(format JSON multi-clients et format ligne de commande Windows).

### Outils

| Outil | Description |
|---|---|
| `qadgraph_status()` | état de Qdrant et de la collection |
| `qadgraph_metrics(threshold)` | métriques complètes (graphe, distributions, payload) |
| `qadgraph_collections()` | toutes les collections |
| `qadgraph_search(query, limit)` | recherche cosine dans la mémoire |
| `qadgraph_recent(limit)` | entrées récentes |
| `qadgraph_topology(threshold, top)` | statistiques du graphe + hubs |
| `qadgraph_point(point_id)` | payload d'un point + voisins proches |
| `qadgraph_logs(tail, stream)` | journaux Qdrant |
| `qadgraph_dashboard()` | URL et commandes du dashboard |

---

## Navigation de la sphère

| Geste | Effet |
|---|---|
| Glisser | orbite libre (la boule se retourne complètement) |
| Molette | zoom |
| Maj + glisser | déplace le plan de vue |
| Clic sur un nœud | sélection + fiche détaillée |
| **Clic dans le vide** | **la boule revient en place** |
| Double-clic | libère un nœud épinglé |
| `E` | rotation auto · `B` 2D/3D · `L` labels · `D` edges |
| `F` recadrer · `U` désépingler · `/` recherche · `1…6` vues · `?` aide |

---

## Notes techniques

- La similarité cosine est calculée **côté serveur** sur des vecteurs
  normalisés : le navigateur reçoit une topologie légère (~40 Ko) au lieu de
  6,3 Mo de vecteurs bruts.
- La matrice complète est plafonnée à `QADGRAPH_MAX_MATRIX` points ; au-delà,
  seules les métriques ponctuelles restent disponibles.
- `d3-force-3d` 3.0.6 + `d3-octree` sont chargés depuis un CDN ; D3 v7 aussi.
  Aucune autre dépendance.

---

## Journal de chantier

Voir [`progress.md`](progress.md).
