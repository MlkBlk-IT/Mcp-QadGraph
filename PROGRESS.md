# QadGraph — Progress

> Journal de chantier vivant. Mis à jour à chaque évolution.
> Projet : `C:\AI\EmbeddingDB\migration-qdrant\qadgraph\`

---

## 1. Objectif

Un plan de contrôle Qdrant local, beau **et** réellement fonctionnel :

- une sphère de mémoire vectorielle **3D rotative** (on peut la tourner dans tous les sens) ;
- chaque élément cliquable produit un résultat observable ;
- des **métriques Qdrant réelles** (tableaux, histogrammes, schémas de payload) ;
- un **serveur MCP** branchable sur n'importe quel client MCP pour interroger ces métriques ;
- le lien `http://127.0.0.1:8766/` et la tâche planifiée **inchangés**.

---

## 2. Bug historique (trouvé et corrigé)

**Symptôme** : le dashboard affichait un graphe vide et la colonne de droite restait
bloquée sur « Fetching vector space data… », alors que le KPI *Total Points* valait 188.

**Console (preuve)** :

```
Sync failed: Error: node not found: 00922580-c3cd-450b-8615-bc4b92ef9c89
Uncaught TypeError: Cannot create property 'vx' on string '169da33b-a5cd-49f6-b7ba-4f6862e13230'  [273 fois]
```

**Cause** — dans `processPoints()` de l'ancien `index.html` :

```js
updateLinks();          // <- les liens sont posés ICI
updateSidebar();
simulation.nodes(nodes); // <- les noeuds seulement ICI
```

`d3.forceLink` résout `link.source` / `link.target` contre la liste de nœuds
**courante** de la simulation. Au moment de `updateLinks()`, cette liste était
vide (premier chargement) → `node not found` → exception → le pipeline
s'interrompait avant `simulation.nodes(...)`. Les liens restaient des chaînes,
et la simulation plantait ensuite à chaque tick (`vx` écrit sur une string).

**Correctif appliqué** (deux verrous) :

1. ordre : `simulation.nodes(nodes)` **puis** `force.links(links)` ;
2. les liens sont passés **en objets** (`source: node, target: node`), ce qui
   supprime définitivement toute résolution d'id par d3.

Voir `qadgraph/web/app.js` → `buildGraph()`.

**Autres bugs corrigés au passage**

| Bug | Correctif |
|---|---|
| CSS invalide (`0% { opacity: .4 } 50% {...}` à l fuera d'un `@keyframes`) | style réécrit proprement (`web/styles.css`) |
| `--bg-deep` utilisé mais jamais défini | tokens unifiés |
| `version` de Qdrant 1.19 est une **chaîne**, pas un objet | `isinstance(ver, dict)` côté serveur |
| Cadrage calculé avant stabilisation de la simulation → graphe hors écran | `scheduleFit()` déclenché par l'événement `end` du layout |
| `var el = el("span", …)` : shadowing de la fonction `el` | variable renommée `chip` |
| Le tiroir de détail recouvrait la barre d'outils | tiroir intégré au layout (grille), plus d'overlay |

---

## 3. Architecture

```
migration-qdrant/
├── dashboard/
│   ├── server.py            <- SHIM : délègue au nouveau serveur
│   ├── legacy-index.html    <- ancien front conservé pour référence
│   └── points_cache.json    <- cache historique (non utilisé par le nouveau moteur)
└── qadgraph/                <- NOUVEAU DOSSIER PROPRE
    ├── server.py            <- serveur HTTP stdlib only (port 8766)
    ├── web/
    │   ├── index.html       <- shell + 6 vues
    │   ├── styles.css       <- design system
    │   └── app.js           <- moteur 3D, vues, interactions
    ├── mcp/
    │   ├── qadgraph_mcp.py  <- serveur MCP (FastMCP)
    │   └── qadgraph-mcp.json<- config prête à coller
    ├── progress.md          <- ce fichier
    └── README.md
```

**Le lien n'est pas cassé** : la tâche planifiée *Hermes Qdrant Tray* et
`scripts/qdrant_dashboard_hidden.vbs` lancent toujours
`dashboard\server.py` ; ce fichier est devenu un shim qui démarre
`qadgraph\server.py`. `http://127.0.0.1:8766/` répond toujours, avec le
nouveau dashboard.

**Contrainte technique** : le serveur est **stdlib only** (http.server, urllib,
json, threading). Raison : la tâche planifiée utilise le Python *système*
(`C:\Python314\python.exe`) comme utilisateur SYSTEM — aucune dépendance
n'y est garantissable. Le MCP, lui, utilise FastMCP (convention du projet) et
doit tourner avec `C:\AI\EmbeddingDB\.venv\Scripts\python.exe`.

---

## 4. Ce que fait le dashboard

### Vue **Vector Topology**
- Sphère 3D (`d3-force-3d`) : 188 points, coque radiale (hubs au centre,
  feuilles sur la coque), cage à 3 grands cercles.
- **Rotation automatique** avec vitesse réglable (0 → 1), orbite libre au drag
  (yaw illimité, pitch ±180° = la boule se retourne complètement), inertie.
- **Clic dans le vide = la boule revient en place** (reset caméra + recadrage).
- Liens **courbés** (béziers) avec courbure déterministe, 3 bandes de force,
  halo + cœur net sur les liens du nœud sélectionné.
- Clic nœud → fiche détaillée (payload, 8 voisins scorés, buttons Center/Copy).
- Hover → tooltip (type, degré, session, importance, extrait).
- Seuil cosine 0.50–0.95, filtre par type via la légende, Labels/Edges on-off.
- Vue 2D/3D (B), Center (F), Unpin (U), aide `?`.

### Vue **Collections**
Tableau de toutes les collections (statut, points, indexés, segments, dims,
distance, optimizer) + **schéma de payload** avec la couverture de chaque champ
en barre de progression.

### Vue **Similarity Search**
Recherche cosine serveur sur les vecteurs normalisés, résultats scorés,
cliquables → sélection dans la sphère.

### Vue **Metrics**
8 tuiles (points, dims, edges, degré moyen/max, similarité max/moyenne, nœuds
isolés, densité, mémoire vecteurs/payload, temps de refresh) +
histogramme des similarités + répartition par type + top nœuds connectés +
sessions + config brute de la collection.

### Vue **Logs**
Queue de `qdrant.stdout.log` / `qdrant.stderr.log`.

### Vue **Config**
`config.yaml` Qdrant + config serveur + **config MCP prête à copier**
(2 formats : JSON multi-clients et ligne de commande Windows).

---

## 5. Serveur MCP

Outils exposés (`qadgraph`) :

| Outil | Rôle |
|---|---|
| `qadgraph_status` | état Qdrant + collection |
| `qadgraph_metrics` | tableau de bord complet |
| `qadgraph_collections` | toutes les collections + métriques |
| `qadgraph_search` | recherche cosine dans la mémoire |
| `qadgraph_recent` | entrées récentes |
| `qadgraph_topology` | stats du graphe + nœuds les plus connectés |
| `qadgraph_point` | payload complet + voisins proches |
| `qadgraph_logs` | queue des journaux Qdrant |
| `qadgraph_dashboard` | URL du dashboard + commandes |

**Adaptatif** : tout se règle par variables d'environnement —
`QADGRAPH_QDRANT`, `QADGRAPH_COLLECTION`, `QADGRAPH_DASHBOARD`,
`QADGRAPH_CACHE_TTL`, `QADGRAPH_MAX_MATRIX`, `QADGRAPH_MAX_EDGES`.

---

## 6. État d'avancement

| # | Tâche | État |
|---|---|---|
| 1 | Diagnostic du bug « graphe vide » (console) | ✅ |
| 2 | Dossier `qadgraph/` + shim (lien préservé) | ✅ |
| 3 | `server.py` stdlib + API metrics/graph/search/logs/config | ✅ |
| 4 | Dashboard 6 vues + tableaux de métriques | ✅ |
| 5 | Sphère 3D rotative, spin, orbite libre, reset au clic vide | ✅ |
| 6 | Liens courbés + cage sphérique | ✅ |
| 7 | Serveur MCP FastMCP (9 outils) | ✅ |
| 8 | `progress.md` + `README.md` | ✅ |
| 9 | Validation navigateur (6 vues + interactions, console 0 erreur) | ✅ |
| 10 | Test réel du serveur MCP (liste d'outils + appel) | ✅ |
| 11 | Vérification finale des routes + tray | ✅ |

---

## 7. Commandes de vérification

```powershell
# serveur
C:\Python314\python.exe -u C:\AI\EmbeddingDB\migration-qdrant\dashboard\server.py

# routes
Invoke-WebRequest http://127.0.0.1:8766/api/health -UseBasicParsing
Invoke-WebRequest 'http://127.0.0.1:8766/api/metrics?threshold=0.65' -UseBasicParsing
Invoke-WebRequest 'http://127.0.0.1:8766/api/graph?threshold=0.65' -UseBasicParsing
Invoke-WebRequest 'http://127.0.0.1:8766/api/search?q=qdrant&limit=3' -UseBasicParsing

# MCP (test stdio)
C:\AI\EmbeddingDB\.venv\Scripts\python.exe C:\AI\EmbeddingDB\migration-qdrant\qadgraph\mcp\qadgraph_mcp.py
```

---

## 8. Pistes d'évolution

- clustering sémantique (HDBSCAN sur la matrice cosine) → groupes colorés ;
- comparaison de snapshots (évolution du graphe dans le temps) ;
- export PNG/SVG de la sphère ;
- alerte sur dérive du nombre de points / du seuil moyen ;
- mode « temps réel » (WebSocket) au lieu du polling 15 s.

---

## 9. Correctif : fenêtre console visible au démarrage (22/10 19:35)

### Symptôme
Un terminal noir `C:\Python314\python.exe` restait affiché sur le bureau, avec le
bannier `[dashboard] delegation vers ...`.

### Cause exacte
La tâche planifiée `Hermes Qdrant Tray` a **deux actions** :

| # | Action | Fenêtre |
|---|---|---|
| 1 | `wscript.exe qdrant_tray_hidden.vbs` | cachée (style 0) |
| 2 | `python.exe -u "...\dashboard\server.py"` | **visible** |

`python.exe` est un exécutable *console* : la tâche étant en `LogonType=Interactive`
/ `RunLevel=HighestAvailable`, Windows lui ouvre une vraie fenêtre sur le bureau.
Le VBS `qdrant_dashboard_hidden.vbs` existait déjà dans le projet mais n'était
**jamais branché** sur la tâche (créée par `install_tray_user4/5/6.ps1`).

### Correctif appliqué
1. **Shim auto-masquant** (`dashboard/server.py`) — sans droits admin :
   `GetConsoleWindow()` + `ShowWindow(hwnd, SW_HIDE)` au démarrage. La console
   reste fonctionnelle mais invisible. `QADGRAPH_SHOW_CONSOLE=1` désactive le masquage.
   Les sorties sont en plus consignées dans `logs\qadgraph_server.log` (tee stdout/stderr).
2. **VBS masqué fiabilisé** (`scripts/qdrant_dashboard_hidden.vbs`) : résolution Python
   `%QADGRAPH_PYTHON%` → `C:\Python314\python.exe` → PATH.
3. **`scripts\fix_qadgraph_hidden_task.ps1`** : bascule l'action 2 de la tâche vers le VBS
   masqué (supprime même le micro-flash de démarrage). **Nécessite l'admin** :
   `Set-ScheduledTask` sur une tâche `HighestAvailable` renvoie `Access is denied` (0x80070005).
4. **`install_tray_user6.ps1` corrigé** : une réinstallation future n'introduit plus la fenêtre.

### Vérification
- pid 16908 (fenêtre visible, `MainWindowHandle=853292`) → remplacé par pid 6024 (`MainWindowHandle=0`).
- Aucun process `python` avec fenêtre visible (`MainWindowHandle -ne 0` → liste vide).
- 9 routes HTTP en 200 après redémarrage ; tray toujours vivant (`healthz green`, pid 1372).
- Sauvegarde de la tâche : `state\hermes_qdrant_tray_task_backup.xml`.
