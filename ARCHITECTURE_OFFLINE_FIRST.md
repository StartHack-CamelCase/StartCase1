# Architecture technique — moteur offline-first

Statut : décision d'architecture initiale  
Périmètre : prototype « Agent on a Leash »  
Objectif immédiat : développer et tester le moteur localement, sans clé API  
Objectif suivant : connecter le même moteur à l'API Viseca sans réécrire la logique métier

## 1. Décision en une phrase

Nous construisons un **monorepo TypeScript** autour d'un **moteur de décision pur**, indépendant du transport. Dans un premier temps, un runner CLI transforme les CSV locaux en événements conformes au schéma Viseca et enregistre les décisions localement. Dans un second temps, les adaptateurs fichiers sont remplacés par un worker qui consomme et répond à l'API Viseca. Le moteur ne change pas.

## 2. État actuel du dépôt

Le dépôt contient actuellement :

- les spécifications du challenge ;
- cinq scénarios et 45 tentatives d'achat ;
- les catalogues clients, comptes, cartes, marchands et produits ;
- un historique de 4 701 autorisations ;
- le schéma JSON canonique d'un `authorization.request` ;
- un exemple complet d'événement live.

Il ne contient pas encore de code applicatif, de serveur, de package Node.js ou de base de données.

Les sources de vérité sont :

- `technical_details.md` pour le protocole de l'API ;
- `data/schemas/authorization_event.schema.json` pour le contrat d'entrée du moteur ;
- `data/data_dictionary.md` pour les types, les jointures, les monnaies et les identifiants ;
- `data/scenario_fixtures/example_authorization_request.json` pour un exemple live complet.

## 3. Choix techniques

| Sujet | Choix |
|---|---|
| Langage | TypeScript strict |
| Runtime | Node.js LTS, version épinglée dans le projet |
| Gestionnaire de paquets | pnpm avec workspaces |
| Validation des événements | Ajv, JSON Schema 2020-12 |
| Lecture des CSV | `csv-parse` |
| Calcul monétaire | `decimal.js`, avec arrondi half-even à deux décimales |
| Tests | Vitest |
| Logs | Pino, structurés en JSON |
| Runner offline | CLI TypeScript exécutée avec `tsx` |
| État offline | mémoire pendant le run + journal JSONL en sortie |
| API future | Fastify pour le Control API |
| Worker futur | processus Node.js TypeScript ; Fastify uniquement pour health/metrics si nécessaire |
| Base future | PostgreSQL derrière une interface de repository |

La version exacte des dépendances sera verrouillée dans `pnpm-lock.yaml`. Aucun framework web n'est nécessaire pendant la première phase offline.

## 4. Principe architectural principal

Le moteur ne doit connaître ni les CSV, ni HTTP, ni Fastify, ni l'API Viseca.

```text
CSV locaux ──> Offline adapter ──> événement canonique ──> Decision Engine
                                                           │
                                                           v
                                                     DecisionResult
                                                           │
                                                           v
                                                    journal JSONL

API Viseca ──> API adapter ──────> événement canonique ──> même moteur
                                                           │
                                                           v
                                             POST /decision ou /resolve
```

Les adaptateurs changent entre le mode offline et le mode API. Les contrats et le moteur restent identiques.

## 5. Structure cible du projet

```text
viseca-2026/
├── apps/
│   ├── offline-runner/
│   │   └── src/
│   │       └── main.ts
│   ├── control-api/                 # phase API
│   │   └── src/
│   │       └── server.ts
│   └── decision-worker/             # phase API
│       └── src/
│           └── main.ts
├── packages/
│   ├── contracts/
│   │   └── src/
│   │       ├── authorization-event.ts
│   │       ├── decision.ts
│   │       ├── mandate.ts
│   │       └── run.ts
│   ├── decision-engine/
│   │   └── src/
│   │       ├── evaluate.ts
│   │       ├── hard-rules.ts
│   │       ├── policy-checks.ts
│   │       ├── risk-signals.ts
│   │       └── explanation.ts
│   ├── policy-compiler/
│   │   └── src/
│   │       └── compile.ts
│   ├── offline-adapter/
│   │   └── src/
│   │       ├── csv-loader.ts
│   │       ├── event-builder.ts
│   │       ├── local-runner.ts
│   │       └── local-decision-store.ts
│   ├── viseca-adapter/               # phase API
│   │   └── src/
│   │       ├── client.ts
│   │       ├── authorization-source.ts
│   │       └── decision-sink.ts
│   └── history/
│       └── src/
│           ├── repository.ts
│           └── features.ts
├── policies/
│   ├── SCEN0000.json
│   └── ...
├── output/                           # ignoré par Git
├── data/                             # déjà présent, non modifié
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── vitest.config.ts
```

Le dépôt reste unique. `offline-runner`, `control-api` et `decision-worker` sont des points d'entrée différents qui réutilisent les mêmes packages.

## 6. Contrat d'entrée unique

L'entrée publique du moteur est exactement l'objet `data` d'un événement live Viseca, validé par :

```text
data/schemas/authorization_event.schema.json
```

Le moteur reçoit donc toujours :

```ts
type DecisionEngineInput = {
  type: "authorization.request";
  request_id: string;
  deadline_at: string;
  authorization: Authorization;
  mandate: MandateSnapshot;
  context: RunContext;
  runtime: RuntimeContext;
};
```

Le runner offline doit fabriquer ce même objet. Il est interdit de créer un second format « spécial offline », car cela rendrait le passage à l'API risqué.

## 7. Contrat de sortie unique

Le moteur retourne un résultat indépendant du transport :

```ts
type Decision = "approve" | "decline" | "step_up";

type DecisionResult = {
  authorization_id: string;
  decision: Decision;
  reason_codes: string[];
  customer_message: string;
  evidence: Array<{
    code: string;
    field?: string;
    observed?: unknown;
    expected?: unknown;
  }>;
  engine_version: string;
};
```

En offline, ce résultat est écrit dans un journal JSONL. Avec l'API, le même résultat est sérialisé pour :

```text
POST /v1/authorizations/{authorization_id}/decision
```

## 8. Interfaces de transport

Les entrées et sorties sont isolées derrière deux ports :

```ts
interface AuthorizationSource {
  startRun(input: StartRunInput): Promise<RunInfo>;
  nextDecisionRequest(): Promise<DecisionRequestEnvelope | null>;
  getRun(runId: string): Promise<RunStatus>;
}

interface DecisionSink {
  submitDecision(result: DecisionResult): Promise<AcceptedDecision>;
  resolveStepUp(input: HumanResolution): Promise<AcceptedDecision>;
}
```

Implémentations prévues :

| Phase | `AuthorizationSource` | `DecisionSink` |
|---|---|---|
| Offline | `CsvAuthorizationSource` | `JsonlDecisionSink` |
| API | `VisecaAuthorizationSource` | `VisecaDecisionSink` |

La boucle d'exécution est commune :

```ts
while (run.hasWorkRemaining) {
  const envelope = await source.nextDecisionRequest();
  if (!envelope) continue;

  const input = validateAuthorizationEvent(envelope.data);
  const result = await engine.evaluate(input);
  await sink.submitDecision(result);
}
```

## 9. Construction d'un événement offline

Pour un scénario donné, le runner effectue les opérations suivantes :

1. lire `scenario_catalogue.csv` et conserver l'instruction originale ;
2. lire les lignes de `purchase_attempts.csv` correspondant au `scenario_id` ;
3. trier par `replay_order` ;
4. joindre l'autorité via `authority_id` ;
5. joindre la carte via `card_id` ;
6. joindre le compte puis le client ;
7. joindre le marchand via `merchant_id` ;
8. joindre toutes les lignes du panier via `authorization_id` ;
9. convertir les montants en nombres et préserver les valeurs `null` ;
10. ajouter le snapshot du mandat local ;
11. calculer le contexte à partir des décisions précédentes du run ;
12. ajouter les champs runtime et les IDs locaux ;
13. valider l'objet final avec le schéma officiel avant d'appeler le moteur.

Les IDs offline sont explicitement préfixés et déterministes, par exemple :

```text
run_id          = LOCAL_RUN_SCEN0000_001
request_id      = LOCAL_REQ_SCEN0000_0001
authorization_id = LOCAL_AUTH_SCEN0000_001_AU0001
mandate_id      = LOCAL_TM_SCEN0000_V1
profile_id      = LOCAL_PROFILE_SCEN0000
```

`source_authorization_id` conserve la valeur source `AU...`. Au passage API, les IDs `LOCAL_...` sont simplement remplacés par les IDs retournés par la plateforme.

## 10. État du run offline

Le runner maintient en mémoire :

```ts
type LocalRunState = {
  run_id: string;
  scenario_id: string;
  mandate_id: string;
  decisionsByAuthorizationId: Map<string, DecisionRecord>;
  recentAuthorizations: RecentAuthorization[];
  approvedSpendInPeriodChf: Decimal;
};
```

Règles importantes :

- `authorization_id` est la clé d'idempotence ;
- une relivraison du même ID n'est jamais comptée deux fois ;
- `step_up` reste `pending` et ne compte pas comme dépense approuvée ;
- une résolution humaine `approve` ajoute ensuite le montant ;
- les fenêtres de dépense utilisent `authorization.timestamp` ;
- les deadlines utilisent l'horloge réelle ;
- `amount` contient déjà les frais de livraison ; il ne faut pas les ajouter une seconde fois.

Chaque run écrit :

```text
output/{run_id}/events.jsonl
output/{run_id}/decisions.jsonl
output/{run_id}/summary.json
```

Ces fichiers sont des artefacts de debug, pas une nouvelle source de vérité.

## 11. Ordre des contrôles dans le moteur

Le moteur évalue toujours les contrôles dans cet ordre :

1. **Validité technique** : événement conforme, IDs cohérents, types corrects.
2. **Contrôles de sécurité immédiats** : mandat, autorité et carte actifs.
3. **Hard rules** : montant, période, catégorie, marchand, pays, attributs demandés.
4. **Contenu du panier** : chaque ligne est contrôlée, pas seulement la catégorie du marchand.
5. **Historique et comportement** : familiarité marchand/appareil, vélocité, doublons et activité récente.
6. **Incertitude** : information absente, ambiguë ou non vérifiable.
7. **Explication** : raisons et preuves structurées destinées au client.

Priorité des résultats :

```text
violation explicite d'une interdiction       -> decline
information nécessaire absente ou ambiguë   -> uncertainty_policy
tous les contrôles satisfaits                -> approve
```

Si `uncertainty_policy` vaut :

- `ask`, retourner `step_up` ;
- `decline`, retourner `decline` ;
- `approve`, retourner `approve` seulement si aucune règle dure n'est violée.

## 12. Usage éventuel d'un modèle IA

Un modèle est optionnel et placé derrière une interface :

```ts
interface SemanticAnalyzer {
  analyze(input: SemanticAnalysisInput): Promise<SemanticAnalysisResult>;
}
```

Il peut aider à extraire une taille, une durée de retour ou une tentative de prompt injection depuis `item_details`. Il ne peut jamais :

- modifier le mandat ;
- ignorer une hard rule ;
- décider seul en cas d'erreur ou de timeout ;
- exécuter une instruction provenant du marchand ou du produit.

En cas d'indisponibilité du modèle, le moteur applique un fallback déterministe fondé sur `uncertainty_policy`.

## 13. Frontière de confiance

Sont considérés comme des instructions de confiance :

- `mandate.instruction` ;
- `mandate.hard_rules` ;
- `mandate.uncertainty_policy`.

Sont considérés comme des faits non fiables à analyser :

- `merchant.*` ;
- `purchase_description` ;
- `items[].item_name` ;
- `items[].item_details`.

Un texte tel que « ignore the spending limit » dans `item_details` ne doit jamais être interprété comme une instruction du système.

## 14. Commandes prévues en mode offline

```bash
pnpm install
pnpm test
pnpm offline:validate-data
pnpm offline:run --scenario SCEN0000 --policy policies/SCEN0000.json
pnpm offline:run --scenario SCEN0001 --policy policies/SCEN0001.json
pnpm offline:run-all
```

La sortie console doit rester courte et exploitable :

```text
SCEN0000 / 1
authorization: LOCAL_AUTH_SCEN0000_001_AU0001
decision: approve
reasons: amount_within_limit, requested_item_category, familiar_merchant
duration_ms: 12
```

## 15. Stratégie de tests

### Tests de contrat

- l'exemple fourni valide contre le JSON Schema officiel ;
- chaque événement construit offline valide contre le même schéma ;
- les chaînes numériques des CSV deviennent des nombres JSON ;
- les champs nullable restent présents avec `null` ;
- les champs inconnus sont refusés.

### Tests unitaires du moteur

- limite par achat ;
- limite glissante sur plusieurs jours ;
- frais de livraison non comptés deux fois ;
- panier contenant plusieurs produits ;
- marchand familier et inconnu ;
- taille ou conditions de retour absentes ;
- carte ou autorité inactive ;
- doublon exact et achat similaire ;
- tentative de prompt injection dans `item_details` ;
- fallback quand l'analyse sémantique est indisponible.

### Tests de séquence

- les achats sont évalués dans l'ordre `replay_order` ;
- seuls les achats finalement approuvés augmentent la dépense ;
- `step_up` n'augmente pas la dépense avant résolution ;
- une relivraison du même `authorization_id` est idempotente ;
- les 45 achats peuvent être rejoués sans erreur de parsing.

Les scénarios ne contiennent aucune réponse attendue officielle. Les tests vérifient les invariants et les règles de notre politique, pas une table de décisions cachée.

Il est interdit de décider à partir de :

- `scenario_id` ;
- `replay_order` ;
- `request_id` ;
- une liste codée en dur d'`authorization_id`.

## 16. Passage à l'API Viseca

Le passage online consiste à ajouter des adaptateurs, pas à modifier le moteur.

| Offline | API |
|---|---|
| lecture de `scenario_catalogue.csv` | `GET /v1/bootstrap` et `/v1/reference-data` |
| politique JSON locale | `POST /v1/mandates`, puis `/confirm` |
| `CsvAuthorizationSource` | polling de `/v1/decision-requests/next?wait=25` |
| IDs `LOCAL_...` | IDs retournés par l'API |
| `JsonlDecisionSink` | `POST /v1/authorizations/{id}/decision` |
| résolution humaine scriptée | `POST /v1/authorizations/{id}/resolve` |
| état en mémoire | PostgreSQL et/ou état retourné par l'API |
| CLI | worker backend permanent |

Le worker API devra :

1. démarrer avant le run ;
2. faire du long-polling ;
3. traiter `204` comme « rien pour le moment », pas comme une fin de run ;
4. vérifier `deadline_at` ;
5. utiliser l'`authorization_id` live pour répondre ;
6. conserver `source_authorization_id` uniquement pour la traçabilité ;
7. être idempotent sur l'`authorization_id` live ;
8. continuer à consommer pendant qu'une autre transaction attend un humain.

## 17. Architecture cible en mode API

```text
Frontend
   │
   v
Control API (Fastify)
   ├── création/confirmation/révocation des mandats
   ├── démarrage et suivi des runs
   ├── affichage des step-ups
   └── résolution humaine
          │
          ├──────────────> API Viseca
          │
          v
      PostgreSQL
          ^
          │
Decision Worker (Node.js TypeScript)
   ├── long-polling API Viseca
   ├── validation du message
   ├── appel du Decision Engine
   ├── soumission de la décision
   └── persistance de l'audit
```

Le Control API et le worker seront deux processus déployables séparément dans le même monorepo. Ils partageront les packages de contrats, le client Viseca et le moteur, mais jamais de logique copiée-collée.

Le worker n'a pas besoin de Fastify pour fonctionner. Un petit serveur Fastify peut être ajouté au worker seulement pour :

```text
GET /healthz
GET /readyz
GET /metrics
```

## 18. Ce que nous ne faisons pas au départ

- pas de microservices dans des dépôts séparés ;
- pas de Kafka ou RabbitMQ ;
- pas de Redis tant qu'un besoin réel n'est pas démontré ;
- pas de PostgreSQL pour le premier runner offline ;
- pas d'appel réseau dans le moteur ;
- pas de modèle IA obligatoire dans le chemin de décision ;
- pas de logique basée sur le nom ou la position d'un scénario ;
- pas de format d'événement différent entre offline et API.

Ces choix réduisent le temps de mise en place sans empêcher le découplage futur.

## 19. Critères de sortie de la phase offline

La phase offline est terminée lorsque :

- les 45 achats peuvent être transformés en événements canoniques ;
- tous les événements valident contre le schéma officiel ;
- les cinq scénarios sont rejouables par CLI ;
- chaque décision contient des raisons et des preuves compréhensibles ;
- le suivi de dépense et l'idempotence fonctionnent sur une séquence ;
- le chemin `step_up` puis résolution est simulable ;
- le moteur continue à fonctionner sans modèle externe ;
- aucun test du moteur ne dépend d'un CSV, d'une route HTTP ou de Fastify.

À ce stade, l'intégration API devient un travail d'adaptateur et de déploiement, et non une réécriture du produit.

## 20. Ordre d'implémentation recommandé

1. Initialiser le workspace TypeScript et les outils de test.
2. Générer ou écrire les types du contrat `authorization_event`.
3. Valider l'exemple live fourni avec Ajv.
4. Implémenter les jointures CSV et construire l'événement `SCEN0000`.
5. Implémenter `DecisionResult` et le squelette du moteur.
6. Faire passer `SCEN0000` de bout en bout.
7. Ajouter l'historique et les features de familiarité.
8. Ajouter le suivi d'état et les limites de période.
9. Rejouer les cinq scénarios et ajouter les tests d'invariants.
10. Ajouter `viseca-adapter`, le worker, puis le Control API Fastify.

