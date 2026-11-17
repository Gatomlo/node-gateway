# Chantiers prévus

Trois chantiers **indépendants**. Les chantiers 1 et 3 peuvent se faire seuls. Le chantier 2 ne démarre que si l'effort se justifie ; s'il est fait, il ajoute une interface au chantier 3 (lot 2.5).

---

## Chantier 1 — Page d'accueil modernisée (simple)

**Objectif** : une page d'accueil lisible et conviviale, qui présente chaque app avec un nom clair, une description et une icône.

**Contenu**
- Manifeste facultatif `gateway.json` à la racine de chaque app :
  ```json
  { "title": "Le Cabas", "description": "Listes de courses partagées du foyer",
    "icon": "icon.png", "color": "#2f9e6e", "category": "Foyer",
    "visibility": "public", "order": 2 }
  ```
  Sans manifeste : repli sur l'existant (nom du dossier, icône détectée, `description` du `package.json`).
- Cartes regroupées par catégorie, recherche instantanée (côté client), thème clair/sombre automatique, adapté aux mobiles.
- Badge « En maintenance » / « Bientôt » préparé (alimenté plus tard par le chantier 2, ou par un champ du manifeste).
- `visibility: "hidden"` masque une app de la page sans la démonter.
- Page en HTML/CSS pur, servie par `server.js`. Aucune dépendance ni JS externe. Toutes les valeurs venant des manifestes sont échappées.

**Hors périmètre** : login, état de santé en direct, toute action.

**Étapes**
1. Lecture et validation de `gateway.json` dans `mountApps()` (types, longueurs, couleur en `#hex`, icône locale uniquement).
2. Nouveau rendu de `/` d'après la maquette `docs/maquette-accueil.html`.
3. Ajout d'un `gateway.json` dans chaque app (dans son propre dépôt).
4. Mise à jour du README et du CLAUDE.md.

**Effort estimé** : petit (une session).

---

## Chantier 2 — Backend dashboard sécurisé (important)

**Objectif** : administrer et surveiller les apps depuis `/_admin`, avec un login centralisé optionnel pour les utilisateurs.
**Référence obligatoire** : `docs/CAHIER-DES-CHARGES-SECURITE.md` (exigences AUTH, SESS, HTTP, CFG, APP, HEALTH, LOG, AUD, MAIL, BKP, PUB, SSO).

**Lots** (chacun livrable et utilisable seul)
| Lot | Contenu | Dépend de |
|---|---|---|
| 2.1 Socle | Route `/_admin` réservée, compte admin (CLI), mot de passe `scrypt`, TOTP + codes de secours, sessions, CSRF, en-têtes, limitation des tentatives, journal d'audit | — |
| 2.2 Santé & logs | État du montage par app, logs préfixés avec rotation, affichage échappé, `/health` minimal | 2.1 |
| 2.3 États des apps | Actif / maintenance / suspendu, persistant, appliqué au démarrage, badge sur la page d'accueil | 2.1, chantier 1 conseillé |
| 2.4 Mail | `ctx` passé aux apps, `ctx.mail.send()`, quotas, alertes regroupées, adresse d'alerte protégée | 2.1 |
| 2.5 Interface backup | Écran du backup (dernières sauvegardes, statut, fréquence, rétention, apps incluses), alerte mail en cas d'échec | 2.1, 2.4, chantier 3 |
| 2.6 Login centralisé | Comptes utilisateurs, droits par app, invitations/réinitialisation par mail, modes `public`/`app`/`gateway`/`hybrid`, `req.gatewayUser` | 2.1, 2.4 |

**Nouvelles dépendances envisagées** : `nodemailer` (2.4). `mysql2` vient du chantier 3. Le TOTP, le hachage et les sessions utilisent le module `crypto` natif.

**Exclu** : installation d'apps, build, redémarrage, exécution de commande (cahier des charges §6).

**Effort estimé** : important (plusieurs sessions). Décision à prendre lot par lot.

---

## Chantier 3 — Sauvegarde des bases SQLite dans MySQL (moyen)

**Objectif** : copier régulièrement les bases SQLite de chaque app dans une base MySQL Infomaniak, et pouvoir les restaurer. Fonctionne **sans dashboard** : configuration par variables d'environnement, restauration en ligne de commande.
**Exigences de sécurité** : CFG-1, BKP-1 à BKP-4 et MAIL-5 du cahier des charges.

**Principe : des instantanés, pas une recopie des tables**
- Copie cohérente de chaque base avec `VACUUM INTO` (fonctionne pendant que l'app écrit), compression gzip, insertion dans **une seule table** :
  ```sql
  CREATE TABLE sqlite_backups (
    id INT AUTO_INCREMENT PRIMARY KEY,
    app VARCHAR(64) NOT NULL, file VARCHAR(128) NOT NULL,
    created_at DATETIME NOT NULL, sha256 CHAR(64) NOT NULL,
    size INT NOT NULL, data LONGBLOB NOT NULL,
    INDEX (app, file, created_at)
  );
  ```
- Si le hash n'a pas changé depuis la dernière sauvegarde, on n'insère rien.
- Rétention : par exemple 7 sauvegardes quotidiennes et 4 hebdomadaires par base, purge automatique.
- Les apps n'ont pas de schéma à convertir ; la restauration consiste à réécrire le fichier `.db`.

**Repérage des bases**
- Chaque app déclare ses fichiers, soit via `gateway.json` (`"backup": ["data/app.db"]`, partagé avec le chantier 1), soit via `module.exports.backupFiles`.
- Bases concernées aujourd'hui : `budget-foyer` (app.db), `cabas` (cabas.db), `mylittlelibrary`, `mystere` (game.db). `repetito` n'utilise pas SQLite.

**Configuration (variables d'environnement, jamais dans Git)**
`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `BACKUP_INTERVAL_HOURS` (défaut 6), `BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`. Si les variables MySQL sont absentes, le backup est désactivé avec un simple avertissement au démarrage.

**Robustesse**
- `backup.js` tourne dans la passerelle (passe au démarrage puis `setInterval`). Toute erreur est attrapée et loguée, jamais propagée au process.
- Pas deux sauvegardes en même temps (verrou en mémoire). Fichiers temporaires dans `os.tmpdir()`, supprimés même en cas d'erreur.
- Vérifier la limite `max_allowed_packet` de MySQL chez Infomaniak ; au-delà, découper les données en morceaux (table `sqlite_backup_chunks`).
- Utilisateur MySQL dédié, avec des droits limités à cette base.

**Restauration (ligne de commande)**
- `npm run backup:list [app]` : liste des sauvegardes (id, date, taille).
- `npm run backup:restore -- <app> <file> [id]` : vérifie le hash, garde la base actuelle en `.db.bak-<date>`, réécrit le fichier (en supprimant les `-wal`/`-shm` éventuels). **À faire passerelle arrêtée** : remplacer une base ouverte par une app en cours d'exécution peut la corrompre. Le script le vérifie (fichier `.restoring` lu au démarrage, ou refus si la passerelle répond). Redémarrer ensuite depuis le manager Infomaniak.
- `npm run backup:now` : sauvegarde immédiate (par exemple avant un déploiement risqué).

**Limites**
- La base MySQL est chez le même hébergeur. Elle protège d'une corruption, d'une erreur dans une app ou d'une mauvaise manipulation, mais pas d'un incident sur le compte Infomaniak. → Prévoir de temps en temps une copie hors site (par exemple un export manuel vers kDrive).
- Une sauvegarde tous les N heures : on peut perdre au maximum N heures de données.

**Étapes**
1. Créer la base et l'utilisateur MySQL dans le manager Infomaniak, vérifier `max_allowed_packet`.
2. `backup.js` (instantané, compression, insertion, déduplication, rétention) avec la dépendance `mysql2`.
3. Scripts `backup:list`, `backup:restore`, `backup:now`.
4. Déclaration des bases dans chaque app.
5. Test complet : sauvegarde → corruption volontaire d'une base de test → restauration.
6. Mise à jour du README et du CLAUDE.md.

**Effort estimé** : moyen (une à deux sessions).
