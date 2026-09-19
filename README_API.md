# Application unifiée Offline / Online

Le switch en haut de l’application choisit la source de travail et conserve le
choix après rechargement. Les listes de runs, préparations, commandes en attente
et profils sont séparés. Un changement de mode annule les lectures en cours et
empêche une réponse tardive de restaurer un ancien écran ou de confirmer l’autre
source. Un run déjà lancé continue son traitement côté serveur.

## Démarrage normal

Node.js 24, dépendances installées :

```sh
cp .env.example .env.local  # uniquement si aucun fichier privé n’existe déjà
# Renseigner TEAM_API_KEY dans .env.local, jamais dans le navigateur.
npm run build
npm run start:local
```

Ouvrir http://127.0.0.1:3210. Conserver le `.env.local` existant si la clé OpenAI
est déjà configurée. Les variables exportées dans le terminal sont prioritaires.
La clé d’équipe précédemment saisie dans la copie parallèle a été transférée au
fichier privé de la racine dans cet espace de travail. Les futurs changements de
clé se font dans le `.env.local` racine.

- **Offline** : replay des achats du pack synthétique, sans appel Viseca.
- **Online** : achat fourni par l’API, décision envoyée à la plateforme,
  comptabilité après acceptation seulement. Les références historiques du pack
  sont figées et leur version est contrôlée à l’ouverture du run si le bootstrap
  fournit `pack_version`.
- Le décodage OpenAI est facultatif et indépendant du choix de source. Avec
  `AI_ENABLED=false`, les instructions prises en charge utilisent le parseur local.
- `VISECA_API_MODE=disabled` désactive l’accès Viseca côté serveur.

Le contrôle distant du 19 septembre a reçu **200 sur `/healthz` puis 401 sur
`/v1/bootstrap`** avec la clé disponible. Le fonctionnement hébergé n’est donc
pas présenté comme validé. Une clé valide est nécessaire pour cette dernière
recette. L’interface indique les erreurs d’authentification; elle ne transforme
jamais un échec de transport en paiement accepté.

## Démonstration API reproductible

```sh
npm run api:demo
```

Wallet : http://127.0.0.1:3212. API locale : http://127.0.0.1:4313. Le bandeau
Online indique **local API emulator**. Aucune clé réelle n’est utilisée; les
requêtes sortantes hors boucle locale et le décodage IA sont bloqués.
Les ports peuvent être changés avec `API_DEMO_PORT` et `API_MOCK_PORT`.

## Confirmation humaine et `/resolve`

Une décision `step_up` conserve une réservation et présente les questions
réellement requises. La confirmation transmet l’identifiant live, l’empreinte de
l’offre, sa révision et les réponses explicites. Le serveur vérifie le client,
la session, le délai, les limites et l’ensemble des réponses avant d’appeler
`POST /v1/authorizations/{id}/resolve` avec `approve` ou `decline`.

Une réponse perdue est journalisée puis réconciliée; elle n’est pas envoyée une
seconde fois aveuglément. Un doublon n’ajoute ni achat ni montant. Une offre ou
révision périmée ne peut pas être approuvée. Un refus connu ne peut pas être
annulé par l’arrivée tardive d’une ancienne approbation.

## Stockage

Le serveur normal conserve les données offline dans `.local-state` et `output`.
Les nouveaux journaux API résident dans `.local-state/live-remote` ou
`.local-state/live-mock`. Les anciens journaux live compatibles restent lisibles
sans déplacement à chaud des fichiers SQLite. La démo utilise intégralement
`.viseca/demo`, séparé du serveur normal. Tous ces états sont ignorés par Git.

## Validation

```sh
npm run typecheck
npm test
npm run api:test
npm run api:check
npm run build
```

[Résultats des scénarios, couverture et limites](docs/18_API_TEST_MATRIX.md).
Les tests utilisent des états temporaires et des confirmations synthétiques
explicites. Ils ne réinitialisent jamais l’équipe distante.
