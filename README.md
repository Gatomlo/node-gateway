# Passerelle Node.js (un seul process pour plusieurs outils)

Infomaniak (comme beaucoup d'hébergements mutualisés) n'autorise qu'**une seule
application Node.js** par hébergement. Cette passerelle est donc *le* point d'entrée
Node unique que tu déploies chez Infomaniak — elle ne fait rien elle-même, elle se
contente de monter chaque outil trouvé dans `apps/` sur une route qui porte le nom de
son dossier.

```
apps/
  repetito/        -> accessible sur /repetito
  budget-foyer/     -> accessible sur /budget-foyer
  mystere/          -> accessible sur /mystere
```

## Page d'accueil

La page `/` liste les outils montes (recherche avec la touche `/`, favoris, "Reprendre", theme clair/sombre). Chaque carte se construit sans configuration, a partir de :

- `manifest.json` de l'outil (racine ou `public/`) : `name`, `description`, `theme_color`, `icons` ;
- `package.json` : `description` ;
- un bloc **facultatif** `"gateway"` du `package.json`, prioritaire :

```json
"gateway": { "name": "The Big Team Quiz", "description": "...", "color": "#E0701F", "tags": ["temps reel"] }
```

Sans rien de tout ca, la carte affiche le nom du dossier avec une couleur stable. Les textes sont echappes avant affichage. Favoris, recents et theme sont gardes dans le navigateur (`localStorage`).

## Ajouter un outil

1. Dépose le dossier complet de l'outil (avec son `package.json`, `node_modules`, etc.)
   dans `apps/<nom-du-dossier>`. Le nom du dossier devient l'URL (`/<nom-du-dossier>`).
2. Redémarre la passerelle (`npm start`). Aucune configuration à écrire ailleurs.

## Ce que doit faire l'outil pour être "montable"

Son fichier d'entrée (`server.js` par défaut, ou le champ `main` de son
`package.json`) doit **exporter l'app Express** au lieu (ou en plus) d'appeler
`app.listen()` directement, pour rester utilisable seul en développement :

```js
if (require.main === module) {
  app.listen(PORT, () => console.log('...'));
}
module.exports = app;
```

Comme le montage se fait avec `app.use('/<nom>', sousApp)`, Express retire
automatiquement le préfixe avant que les routes internes (`/api/...`) ne le voient —
aucune adaptation cotê serveur n'est nécessaire pour ça.

**Côté navigateur en revanche**, l'outil doit éviter les chemins absolus commençant
par `/` dans son HTML/JS (`<script src="/app.js">`, `fetch('/api/...')`, etc.) : une
fois monté sur `/mon-outil`, ces chemins absolus pointeraient vers la racine de la
passerelle et non vers `/mon-outil/...`. Utilise des chemins relatifs partout
(`app.js`, `api/...`), éventuellement en déduisant le préfixe réel au runtime (voir
comment Répétito le fait dans `apps/repetito/public/app.js`, constante `BASE`, calculée
à partir de l'URL réelle du script chargé — fonctionne qu'il soit servi à la racine ou
sous un sous-dossier, sans configuration à coder en dur).

## Outils avec temps reel (Socket.IO) — hook optionnel

La passerelle cree elle-meme le serveur HTTP (`http.createServer(app)`, equivalent a `app.listen`). Un outil qui exporte en plus de son app Express une fonction `attachToServer(httpServer, { mountPath })` la recevra au montage, par exemple pour y attacher Socket.IO sous `<mountPath>/socket.io` :

```js
app.attachToServer = (httpServer, { mountPath }) => {
  const io = new Server(httpServer, { path: mountPath + '/socket.io' });
  // ...
};
module.exports = app;
```

Les outils qui n'exportent pas cette fonction sont montes exactement comme avant.

## Sauvegarde automatique des bases SQLite (vers MySQL)

La passerelle copie périodiquement les bases SQLite des outils (`*.db`, `*.sqlite`, `*.sqlite3` sous `apps/<outil>/`, hors `node_modules`) dans une base MySQL, **chiffrées** (gzip + AES-256-GCM, clé conservée hors de la base). La copie est cohérente même si l'outil écrit en même temps (mode WAL).

- **Inactive tant que `BACKUP_KEY` n'est pas définie** : sans configuration, la passerelle démarre comme avant.
- Prérequis : Node ≥ 22.5 (`node:sqlite`), un compte MySQL dédié.
- Fréquence : toutes les 6 h par défaut, 1er passage 30 s après le démarrage. Une base inchangée n'est pas re-sauvegardée.
- Rétention : 7 quotidiennes, 4 hebdomadaires, 6 mensuelles.
- Une erreur de sauvegarde est seulement journalisée, elle n'arrête jamais la passerelle.

### Mise en route (une seule fois)

1. **MySQL** : dans le manager Infomaniak, créer une base et un utilisateur dédiés, avec les droits `SELECT`, `INSERT`, `DELETE` (+ `CREATE` pour la première exécution).
2. **Déployer** cette version de la passerelle, puis en SSH dans son dossier :
   ```
   npm install
   npm run backup:setup
   ```
   Le script demande hôte, base, utilisateur et mot de passe (saisie masquée), génère la clé `BACKUP_KEY`, écrit `.env` (droits 600, ignoré par Git, chargé au démarrage), teste MySQL, crée les tables et liste les bases SQLite détectées.
3. **Copier la clé affichée dans un gestionnaire de mots de passe.** Elle n'est montrée qu'une fois et **sans elle les sauvegardes sont illisibles**. Ne la coller ni dans un chat ni dans Git.
4. **Redémarrer** la passerelle. Les lignes `[backup] ... sauvegarde` apparaissent dans les logs.
5. **Tester la restauration** une fois (voir ci-dessous, mode 1) : une sauvegarde jamais restaurée n'est pas une sauvegarde.

Si le compte n'a pas le droit `CREATE`, créer les tables avec le SQL de la constante `SCHEMA` dans `lib/backup-store.js`.

### Restaurer une sauvegarde (SSH)

```
npm run restore                      # mode interactif (recommandé)
npm run restore -- list [outil]      # lister les sauvegardes
npm run restore -- <id> [--replace]  # restaurer directement la sauvegarde #id
```

En mode interactif : choix de l'outil, puis de la date (1 = la plus récente), puis :

1. **écrire `<fichier>.restored`** à côté de la base, sans rien écraser (pour vérifier le contenu) ;
2. **remplacer la base actuelle**, après confirmation en tapant `oui`. L'ancienne base est conservée en `<fichier>.bak-<date>`.

**Arrêter la passerelle avant de remplacer une base**, puis la relancer. Une sauvegarde modifiée ou rattachée à un autre outil est refusée avant toute écriture.

### Configuration (facultatif)

Variables d'environnement, définies dans `.env` (ou dans le manager de l'hébergement, qui est prioritaire) :

| Variable | Rôle |
|---|---|
| `BACKUP_KEY` | 64 caractères hexa. Génération manuelle : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DB_HOST`, `DB_PORT` (3306), `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Accès MySQL |
| `BACKUP_INTERVAL_HOURS` | Fréquence en heures (6 par défaut) |
| `BACKUP_PRUNE=0` | Désactive la rétention. Le droit `DELETE` devient alors inutile : table en ajout seul |

Par outil, le bloc `"gateway": { "backup": ["data/app.sqlite"] }` du `package.json` remplace la détection automatique (`[]` = ne rien sauvegarder).

### Limites et bonnes pratiques

- La sauvegarde est sur **le même hébergeur** : elle protège d'une corruption ou d'une suppression de fichier, pas de la perte de l'hébergement. Faire de temps en temps un `mysqldump` vers un autre support.
- `.env` contient le mot de passe MySQL **et** la clé sur le même serveur : protéger l'accès SSH/SFTP.
- Conserver la clé `BACKUP_KEY` séparément (gestionnaire de mots de passe). La changer rend les anciennes sauvegardes illisibles.

## En développement local (ce PC)

Plutôt que de dupliquer le code de chaque outil dans `apps/`, on peut créer un lien
symbolique (jonction Windows) qui pointe vers le dossier de projet existant :

```powershell
New-Item -ItemType Junction -Path "apps\repetito" -Target "C:\Users\thoma\ClaudeIA\theatre-repliques"
```

Les éditions se font alors directement dans le vrai dossier du projet, sans copie.

## Déploiement chez Infomaniak

Sur l'hébergement, `apps/<nom>` contient une vraie copie du code de chaque outil (pas
de jonction — on envoie les fichiers par SFTP/Git). Seule cette passerelle est
déclarée comme "site Node.js" dans le manager Infomaniak (fichier de démarrage :
`server.js`) ; elle route ensuite vers chaque outil en interne.

## Port

`PORT` (variable d'environnement, `3000` par défaut) est le port de la passerelle
elle-même. Les `PORT` internes des outils montés ne sont pas utilisés dans ce mode
(ils n'appellent pas `app.listen()`).
