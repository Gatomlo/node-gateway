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
