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

La passerelle copie les bases SQLite des outils (`*.db`, `*.sqlite`, `*.sqlite3` sous `apps/<outil>/`, hors `node_modules`) dans MySQL, **chiffrees** (gzip + AES-256-GCM, cle hors base). Elle est **inactive tant que `BACKUP_KEY` n'est pas definie**. Necessite Node >= 22.5 (`node:sqlite`).

**Installation guidee (recommandee)** : en SSH dans le dossier de la passerelle, `npm install` puis `node scripts/setup-backup.js`. Le script genere `BACKUP_KEY` (affichee une seule fois : la copier dans un gestionnaire de mots de passe), demande hote / base / utilisateur / mot de passe (masque), ecrit `.env` (droits 600, ignore par Git, charge au demarrage), teste MySQL, cree les tables et liste les bases detectees.

Ou a la main, avec ces variables d'environnement (manager Infomaniak ou `.env`, jamais dans le depot) :

| Variable | Role |
|---|---|
| `BACKUP_KEY` | 64 caracteres hexa : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. **A sauvegarder ailleurs : sans elle, les sauvegardes sont illisibles.** |
| `DB_HOST`, `DB_PORT` (3306), `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Acces MySQL |
| `BACKUP_INTERVAL_HOURS` | Frequence (6 par defaut) ; une base inchangee n'est pas re-sauvegardee |
| `BACKUP_PRUNE=0` | Desactive la retention (7 quotidiennes, 4 hebdo, 6 mensuelles) |

Par outil, le bloc `"gateway": { "backup": ["data/app.sqlite"] }` du `package.json` remplace la detection automatique (`[]` = ne rien sauvegarder).

Droits MySQL du compte dedie : `SELECT, INSERT, DELETE` (+ `CREATE` une fois pour creer les tables, sinon executer le SQL de `lib/backup-store.js`, constante `SCHEMA`). `DELETE` sert a la retention ; retirer ce droit et poser `BACKUP_PRUNE=0` si on prefere une table en ajout seul.

Restauration **manuelle** en SSH (arreter la passerelle avant de remplacer) :

```
npm run restore                      # mode interactif : choix de l'outil, de la date, confirmation
npm run restore -- list [outil]
npm run restore -- <id> [--replace]
```

Sans `--replace`, la base est ecrite en `<fichier>.restored` sans rien ecraser. Une sauvegarde alteree est refusee (authentification GCM). La copie reste chez le meme hebergeur : faire de temps en temps un export `mysqldump` vers un autre support.

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
