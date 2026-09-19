# Viseca — installation et configuration

Application TypeScript locale de contrôle des achats d'un agent. Le serveur Fastify sert l'interface et l'API ; le runtime utilise le pack CSV fourni et un stockage local JSON/SQLite.

| Documentation du projet | Contenu |
| --- | --- |
| Ce README | Installation, variables d'environnement et démarrage |
| [Structure des données](docs/02_STRUCTURE_DONNEES.md) | Pack source, contrats TypeScript et stockage |
| [Routes utilisées](docs/03_ROUTES_ET_PARCOURS.md) | Pages, API locale, appels externes et simulateur |

Les documents fournis par les organisateurs restent disponibles : [énoncé du challenge](challenge.md), [contrat technique de l'API](technical_details.md), [guide du pack](data/README.md) et [dictionnaire des données](data/data_dictionary.md).

## Prérequis

- Node.js **24.15.0** (voir [.nvmrc](.nvmrc) ; plage acceptée : `>=24.15.0 <25`). SQLite est fourni par Node, sans serveur de base de données à installer.
- pnpm **11.19.0**, version fixée dans [package.json](package.json).
- Une clé OpenAI pour préparer une nouvelle instruction dans l'interface, quel que soit le mode d'achat. Les données enregistrées et les commandes d'inspection restent accessibles sans clé.
- Une clé d'équipe Viseca pour utiliser l'API distante en mode Online.

## Installer

Depuis la racine du dépôt cloné :

```sh
nvm install
nvm use
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
```

`nvm` est facultatif si la bonne version de Node est déjà installée. Le workspace et l'autorisation de compilation d'esbuild sont définis dans [pnpm-workspace.yaml](pnpm-workspace.yaml).

Créer le fichier de configuration uniquement s'il n'existe pas :

```sh
test -f .env.local || cp .env.example .env.local
```

Modifier ensuite `.env.local`. Il est ignoré par Git, tout comme les états d'exécution. Le serveur charge ce fichier au démarrage depuis le répertoire courant ; les variables déjà exportées dans le terminal ont priorité. Redémarrer le serveur après un changement.

## Configurer

| Variable | Valeur dans `.env.example` / défaut | Utilisation |
| --- | --- | --- |
| `PORT` | `3210` | Port de l'interface et de l'API locale ; écoute sur `127.0.0.1` |
| `AI_ENABLED` | `false` dans l'exemple | Mettre `true` pour les nouveaux décodages et l'extraction facultative des offres. Le code désactive l'IA lorsque la valeur vaut exactement `false` ; une clé est également nécessaire. |
| `OPENAI_API_KEY` | Vide | Clé utilisée uniquement côté serveur |
| `OPENAI_MODEL` | `gpt-5.4` | Modèle du décodage d'instruction. L'extraction facultative des offres utilise séparément `gpt-5-nano`. |
| `VISECA_API_MODE` | `remote` | `remote` pour l'API hébergée, `mock` pour une API HTTP sur boucle locale, `disabled` pour désactiver l'accès Viseca du serveur |
| `LEASH_BASE_URL` | `https://leash-api-production.up.railway.app` dans l'exemple | Origine de l'API Viseca ; le serveur requiert sa configuration pour Online |
| `TEAM_API_KEY` | Vide | Clé d'équipe envoyée à Viseca par le serveur |
| `LOCAL_STATE_DIR` | `.local-state` | Politiques, décodages, simulations, wallet et sessions live |
| `LOCAL_OUTPUT_DIR` | `output` | Runs d'inspection, événements et traces |

Les chemins personnalisés sont résolus depuis le répertoire courant. Les dossiers du pack (`data`), des états et des sorties doivent être distincts et ne pas être imbriqués. Utiliser une seule instance du serveur par dossier de stockage.

Pour préparer des achats à partir du pack CSV, renseigner notamment :

```dotenv
VISECA_API_MODE=disabled
AI_ENABLED=true
OPENAI_API_KEY=remplacer_par_votre_cle
OPENAI_MODEL=gpt-5.4
```

Le mode **Offline** choisit les achats du pack CSV ; une nouvelle préparation d'instruction appelle tout de même OpenAI. Avec `AI_ENABLED=false`, les nouveaux décodages et préparations sont bloqués, et les activités sauvegardées restent consultables. Un échec OpenAI ne crée pas de permissions de remplacement.

Pour les achats **Online**, configurer en plus `VISECA_API_MODE=remote`, `LEASH_BASE_URL` et `TEAM_API_KEY`, puis choisir Online dans l'interface. Les profils et les activités sont séparés par mode. L'adresse de référence pour configurer l'application est celle de [.env.example](.env.example) ; l'adresse Azure encore citée dans le contrat technique d'origine est historique.

## Démarrer

```sh
pnpm build
pnpm start:local
```

Ouvrir [http://127.0.0.1:3210](http://127.0.0.1:3210) et garder le terminal du serveur ouvert. Le build génère `dist/` ; `start:local` utilise ce résultat.

```sh
curl --fail http://127.0.0.1:3210/api/health
```

La réponse attendue contient `status: "ok"`, `pack.available: true`, cinq scénarios et 45 achats. Ce contrôle vérifie le chargement local, pas l'accès OpenAI ou Viseca. Un pack ou un état impossible à charger produit un HTTP 503 avec la cause dans `pack.error`.

Pour développer :

```sh
pnpm dev:local
```

Cette commande fait un build initial puis surveille les modules du serveur. Les fichiers de l'interface servis viennent de `dist/` : relancer `pnpm build` après une modification du navigateur, ou redémarrer `dev:local`.

Pour démarrer en imposant la configuration distante :

```sh
pnpm api:remote
```

Cette commande reconstruit l'application, vérifie une clé d'équipe renseignée et une origine HTTPS, puis démarre le même serveur avec `VISECA_API_MODE=remote`.

## Simulateur API local

```sh
pnpm api:demo
```

Cette commande construit et démarre l'interface sur [http://127.0.0.1:3212](http://127.0.0.1:3212) et l'émulateur API sur [http://127.0.0.1:4313](http://127.0.0.1:4313), dans `.viseca/demo`. Elle bloque les appels réseau hors boucle locale et désactive l'IA : les nouvelles préparations d'instruction ne sont donc pas disponibles dans cette démonstration isolée. `pnpm api:demo:start` réutilise un build existant.

| Variable de démonstration | Défaut |
| --- | --- |
| `API_DEMO_PORT` | `3212` |
| `API_MOCK_PORT` | `4313` |
| `API_DEMO_STATE_DIR` | `.viseca/demo` |

Pour démarrer l'émulateur seul, puis vérifier ses routes depuis un autre terminal :

```sh
pnpm api:mock
```

```sh
pnpm api:local health
pnpm api:local reads
```

L'émulateur seul utilise `.local-state/api-mock` (`API_MOCK_STATE_DIR` permet de changer ce chemin). `API_MOCK_CONTRACT_PROFILE=railway pnpm api:mock` active les variantes de réponse encodées pour Railway ; le profil par défaut est `documented`. Ces variables sont à exporter dans le terminal : `api:mock` et `api:demo` ne chargent pas `.env.local`.

## Laboratoire et CLI

Le laboratoire utilise `.env.local` et peut contrôler la connexion à l'API configurée sans démarrer l'interface :

```sh
pnpm api:lab config
pnpm api:lab health
pnpm api:lab reads
pnpm api:lab routes
pnpm api:lab --help
```

`config` masque la clé ; `reads` lit bootstrap, références, historique, autorisations et événements. Les rapports vont dans `.viseca/api-lab`. Les POST/PATCH exigent un fichier JSON avec `--file` (sauf `draft`, qui fournit un exemple limité au prix). Le GET `/v1/decision-requests/next` consomme une livraison et n'est pas inclus dans `reads`. Les mutations ne sont pas répétées automatiquement. `VISECA_API_MODE=disabled` bloque les appels réseau du laboratoire ; `api:local` force le mode mock et bloque le réseau distant.

Le worker terminal est disponible via `pnpm live prepare`, puis `pnpm live create-run --config binding.json` ou `pnpm live follow --config binding.json --run-id RUN_ID`. Il charge `.env.local` et nécessite un `LiveBinding` valide, décrit dans la [structure des données](docs/02_STRUCTURE_DONNEES.md), ainsi qu'un mandat distant déjà confirmé. `pnpm live status --config binding.json --run-id RUN_ID` lit la progression.

## Vérifier l'installation

```sh
pnpm offline:validate-data
pnpm offline:inspect --scenario SCEN0000
pnpm typecheck
pnpm test
pnpm api:test
pnpm api:check
```

Les commandes d'inspection utilisent un stockage temporaire et n'appellent ni Viseca ni OpenAI. `pnpm offline:inspect-all` parcourt les cinq scénarios et les 45 achats sans rendre de décision de paiement ; ils restent « Non évalués ». `api:test` teste le laboratoire CLI ; `api:check` contrôle les contrats API et les protections du réseau local.

Les scripts supplémentaires disponibles sont listés dans [package.json](package.json). Après installation des dépendances avec pnpm, on peut également lancer les scripts avec `npm run <nom>` (ajouter `--` avant leurs arguments).

## Emplacement du code

| Dossier | Rôle |
| --- | --- |
| `apps/local-web` | Serveur Fastify et interface navigateur |
| `apps/api-mock` | Émulateur de l'API Viseca et démonstration locale |
| `apps/api-lab` | Client HTTP et laboratoire CLI |
| `apps/offline-runner` | Commandes d'inspection, d'évaluation et worker live |
| `packages/contracts` | Types des données, politiques, décisions et échanges |
| `packages/local-runtime` | Chargement du pack, services, moteurs et stockage |
| `data` | CSV, schémas JSON, manifeste et fixtures fournis |
| `tests` | Tests et fixtures du projet |

Le détail des fichiers persistés est dans la [structure des données](docs/02_STRUCTURE_DONNEES.md). Les états normaux (`.local-state`, `output`) et ceux des outils (`.viseca`) sont ignorés par Git ; les chemins personnalisés doivent être exclus séparément si nécessaire.
