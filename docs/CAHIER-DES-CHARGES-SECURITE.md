# Cahier des charges sécurité — dashboard & login centralisé

Statut : **spécification, non implémentée**. Version 1 — 2026-10-10.

## 1. Périmètre

Inclus :
- Dashboard d'administration (`/_admin`) : santé des apps, suspension, maintenance, journal d'audit, alertes mail, paramétrage du backup.
- Service mail (SMTP) offert aux apps.
- Page publique d'accueil.
- Login centralisé optionnel (section 4).

Exclus définitivement (voir §6) : installation d'apps, build, redémarrage, toute exécution de commande depuis l'interface.

## 2. Principes

1. **Le code n'arrive que par le déploiement (SFTP/Git)**, jamais par l'interface web.
2. **Les secrets et les destinations de données vivent hors de l'interface** (variables d'environnement). Le dashboard règle des paramètres, pas des cibles.
3. **Actions prédéfinies uniquement** : aucun champ libre interprété comme commande, chemin ou code.
4. **La passerelle survit à tout** : une erreur du dashboard, d'une app, du SMTP ou de MySQL est loguée, jamais propagée au process.
5. **Pire cas d'une session admin volée = interruption de service**, pas de vol de données en masse ni d'exécution de code.

## 3. Modèle de menace

| Menace | Couverte par |
|---|---|
| Brute force / vol de mot de passe admin | AUTH-1 à AUTH-6 |
| Vol de session, CSRF, clickjacking | SESS-1 à SESS-5, HTTP-1 à HTTP-4 |
| XSS via contenu de logs | LOG-3, HTTP-1 |
| Exfiltration des données via la config (backup, SMTP) | CFG-1 à CFG-4 |
| Masquage d'une intrusion (alertes détournées, audit effacé) | CFG-3, AUD-1 à AUD-4 |
| Spam via le SMTP / saturation de la boîte mail | MAIL-2 à MAIL-5 |
| Saturation disque par les logs | LOG-4 |
| Fuite d'informations par la page publique ou `/health` | PUB-1 à PUB-3 |
| **App compromise** (même process) | **Non couvert** — voir §7 |

## 4. Exigences

### Authentification admin (AUTH)
- **AUTH-1** Un seul compte admin, créé en ligne de commande ou par variable d'environnement. Aucune création ou inscription depuis l'interface.
- **AUTH-2** Mot de passe haché avec `scrypt` (natif Node) ou argon2. Minimum 12 caractères.
- **AUTH-3** TOTP obligatoire pour l'admin. Codes de secours générés une fois et affichés une seule fois.
- **AUTH-4** Limitation des tentatives par IP et par compte (ex. 5 échecs → blocage progressif). Message d'erreur identique quelle que soit la cause.
- **AUTH-5** Nouvelle saisie du TOTP exigée pour les actions sensibles : modifier l'adresse des alertes, restaurer un backup (si un jour activé), gérer les utilisateurs.
- **AUTH-6** Option : liste d'adresses IP autorisées pour `/_admin` (variable d'environnement).

### Sessions (SESS)
- **SESS-1** Cookie `HttpOnly`, `Secure`, `SameSite=Strict` pour l'admin (`Lax` toléré pour le login centralisé), identifiant aléatoire de 256 bits.
- **SESS-2** Expiration après 30 min d'inactivité et durée maximale de 12 h pour l'admin.
- **SESS-3** Identifiant de session régénéré à chaque connexion. Déconnexion = invalidation côté serveur.
- **SESS-4** Token CSRF sur toute requête qui modifie quelque chose (POST/PUT/DELETE). Aucune action par GET.
- **SESS-5** Liste des sessions actives visible dans le dashboard, avec possibilité de les révoquer.

### En-têtes HTTP du dashboard (HTTP)
- **HTTP-1** CSP stricte : `default-src 'self'`, pas de `unsafe-inline` ni `unsafe-eval`.
- **HTTP-2** `frame-ancestors 'none'` et `X-Frame-Options: DENY` (anti-clickjacking).
- **HTTP-3** `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.
- **HTTP-4** HSTS sur le domaine si HTTPS est géré par Infomaniak.

### Configuration et secrets (CFG)
- **CFG-1** Uniquement en variables d'environnement, jamais modifiables dans l'interface : identifiants et hôte MySQL, identifiants et hôte SMTP, adresse d'expédition, clé de chiffrement, compte admin initial.
- **CFG-2** Modifiable dans l'interface : fréquence et rétention du backup, apps incluses dans le backup, état des apps, seuils d'alerte. Chaque valeur est validée (type, bornes, liste fermée).
- **CFG-3** Changer l'adresse des alertes exige une nouvelle saisie du TOTP et envoie une notification à l'**ancienne** adresse.
- **CFG-4** Le fichier de config (`data/gateway.json`) est hors Git, enregistré de façon atomique (fichier temporaire puis renommage) et ne contient aucun secret.

### Gestion des apps (APP)
- **APP-1** Trois états : `actif`, `maintenance` (page 503 aimable), `suspendu` (503 minimal). Le blocage se fait par un middleware placé **avant** le routeur de l'app.
- **APP-2** L'état est persistant et appliqué dès le démarrage, avant le montage des apps.
- **APP-3** Il est documenté qu'une app suspendue reste chargée : ses tâches de fond continuent. Pour un arrêt réel, il faut la retirer par le déploiement.
- **APP-4** Le nom `_admin` (et tout nom commençant par `_`) est réservé : `mountApps()` refuse de monter une app portant ce nom.

### Santé (HEALTH)
- **HEALTH-1** Le dashboard affiche par app : état du montage (OK / erreur et message), état actif/maintenance/suspendu, taille du dossier `data/`, date du dernier backup réussi, nombre d'erreurs récentes.
- **HEALTH-2** `/health` public : répond `200 OK` ou `503`, sans aucun corps détaillé.

### Logs (LOG)
- **LOG-1** Les `console.*` de chaque app sont préfixés par le nom de l'app pour pouvoir les filtrer.
- **LOG-2** Rien de sensible n'est logué : mots de passe, tokens, cookies, en-tête `Authorization`, corps des requêtes de login.
- **LOG-3** Tout log est **échappé** à l'affichage (jamais inséré comme HTML).
- **LOG-4** Rotation des fichiers de log par taille (ex. 5 × 2 Mo) pour borner l'espace disque.

### Journal d'audit (AUD)
- **AUD-1** Enregistre : connexions réussies et échouées (IP, user-agent), changements d'état d'une app, changements de config, gestion des utilisateurs, envois d'alertes.
- **AUD-2** Ajout seul : aucune suppression ni modification depuis l'interface.
- **AUD-3** Conservé séparément des logs applicatifs, et inclus dans le backup.
- **AUD-4** Chaque entrée contient : date UTC, acteur, action, cible, ancienne valeur → nouvelle valeur (sans secrets).

### Mail (MAIL)
- **MAIL-1** Les apps reçoivent `ctx.mail.send({to, subject, text, html})`, jamais les identifiants SMTP.
- **MAIL-2** L'adresse d'expédition est fixe (CFG-1) et ne peut pas être choisie par l'app. `replyTo` est autorisé.
- **MAIL-3** Quota par app (ex. 50 mails/heure, paramétrable) et refus au-delà, avec trace dans l'audit.
- **MAIL-4** Les en-têtes sont validés (pas de retour à la ligne dans `to` ou `subject` → pas d'injection d'en-têtes), avec un nombre limité de destinataires par mail.
- **MAIL-5** Alertes regroupées (« app X : 340 erreurs en 10 min ») avec au plus 1 mail par type d'alerte et par période. Corps sans données personnelles : app, type d'erreur, lien vers le dashboard.

### Backup (BKP)
- **BKP-1** Destination MySQL définie uniquement par variables d'environnement (CFG-1).
- **BKP-2** Aucune restauration depuis l'interface dans un premier temps (script en ligne de commande). Si elle est ajoutée plus tard : uniquement depuis les sauvegardes MySQL, avec nouvelle saisie du TOTP et trace dans l'audit.
- **BKP-3** Aucun téléchargement de sauvegarde depuis l'interface.
- **BKP-4** Échec du backup → alerte mail (MAIL-5).

### Page publique (PUB)
- **PUB-1** Construite à partir du manifeste `gateway.json` de chaque app : nom, description, icône, visibilité (`public` / `privé` / `caché`).
- **PUB-2** Une app `cachée` n'apparaît nulle part publiquement. Une app `privée` n'apparaît qu'aux utilisateurs connectés qui y ont droit.
- **PUB-3** Aucun message d'erreur, numéro de version ou détail technique.

## 5. Login centralisé (SSO)

### Principe
Toutes les apps sont servies par **la même origine**. Un seul cookie de session de la passerelle est donc valable pour toutes, sans protocole SSO complexe (pas d'OAuth ni d'OIDC).

### Modes d'authentification par app (déclarés dans `gateway.json`)
| Mode | Comportement |
|---|---|
| `public` | Aucune vérification par la passerelle. |
| `app` | L'app gère son propre login. La passerelle ne fait rien (comportement actuel). |
| `gateway` | La passerelle exige une connexion et un droit d'accès à cette app, puis transmet l'identité. |
| `hybrid` | L'app garde son login, mais accepte aussi l'identité transmise par la passerelle quand elle existe. |

### Exigences
- **SSO-1** Comptes utilisateurs distincts du compte admin. Un utilisateur « accès à tout » **n'est pas** admin du dashboard.
- **SSO-2** Droits par utilisateur et par app : liste des apps autorisées, avec un rôle optionnel (`lecteur` / `éditeur`) que l'app interprète.
- **SSO-3** Pas d'inscription libre. L'admin crée un compte, puis la personne reçoit un **lien d'invitation** à usage unique (valable 48 h) pour choisir son mot de passe.
- **SSO-4** Réinitialisation du mot de passe par lien mail à usage unique (valable 30 min), avec une réponse identique que le compte existe ou non.
- **SSO-5** L'identité est transmise à l'app par une **propriété de la requête** (`req.gatewayUser = {id, email, nom, rôle}`), jamais par un en-tête HTTP, qu'un client pourrait falsifier. La passerelle supprime tout en-tête entrant qui imite cette identité.
- **SSO-6** Une app en mode `hybrid` relie l'utilisateur de la passerelle à son propre compte par l'email, et ne crée de compte local que si l'app le prévoit explicitement.
- **SSO-7** Révoquer un utilisateur ou un droit invalide immédiatement ses sessions dans la passerelle. Les sessions propres aux apps en mode `app` ou `hybrid` relèvent de chaque app (limite documentée).
- **SSO-8** TOTP facultatif pour les utilisateurs, obligatoire pour l'admin. Passkeys (WebAuthn) envisageables plus tard.
- **SSO-9** Mêmes exigences que AUTH-2, AUTH-4 et SESS-1 à SESS-4 pour le login utilisateur.

### Exemple de droits
| Utilisateur | Apps |
|---|---|
| Admin (Thomas) | dashboard + toutes |
| Conjointe | toutes (pas le dashboard) |
| Collègues | mylittlelibrary |
| Amis | Kdo |

## 6. Exclusions explicites
- Installation ou mise à jour d'apps depuis l'interface (archive, Git ou autre).
- `npm install`, build ou redémarrage depuis l'interface.
- Terminal, champ de commande, exécution de scripts.
- Explorateur ou éditeur de fichiers.
- Affichage en clair d'un secret.
- Modification libre des variables d'environnement.
- Restauration depuis un fichier envoyé par le navigateur, téléchargement de sauvegardes.
- Inscription libre, comptes admin multiples.

## 7. Limites acceptées
- **Process partagé** : une app compromise peut lire la mémoire, la config, les sessions et les secrets de la passerelle. → N'installer que des apps dont le code est relu.
- **Origine partagée** : le JavaScript d'une app peut appeler les autres apps avec la session de l'utilisateur, et lire les cookies qui ne sont pas `HttpOnly`. → Cookies de session `HttpOnly`. Une faille XSS dans une app touche potentiellement toutes les apps.
- **Login centralisé** : une session de la passerelle compromise donne accès à toutes les apps autorisées pour cet utilisateur.

## 8. Critères de validation
- [ ] Le 6e mot de passe faux d'affilée est bloqué ; la connexion admin est impossible sans TOTP.
- [ ] Une requête POST sans token CSRF est refusée (403).
- [ ] Le dashboard ne peut pas être affiché dans une `<iframe>` d'une autre origine.
- [ ] Une ligne de log contenant `<script>` s'affiche comme du texte.
- [ ] Aucune route de l'interface n'accepte d'hôte, de chemin ou de commande en paramètre.
- [ ] Une app suspendue répond 503, y compris juste après un redémarrage.
- [ ] Une app nommée `_admin` n'est pas montée.
- [ ] Le 51e mail d'une app dans l'heure est refusé.
- [ ] 1000 erreurs en 1 min produisent 1 seul mail d'alerte.
- [ ] Un en-tête `X-Gateway-User` envoyé par un client est ignoré.
- [ ] Un utilisateur sans droit sur une app en mode `gateway` reçoit 403 ; un utilisateur révoqué est déconnecté immédiatement.
- [ ] `/health` et la page publique ne révèlent aucune erreur ni version.
