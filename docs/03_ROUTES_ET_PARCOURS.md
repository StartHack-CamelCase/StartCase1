# Routes HTTP

Référence vérifiée sur le code du dépôt le 19 septembre 2026. Les types des objets sont détaillés dans la [structure des données](02_STRUCTURE_DONNEES.md) ; les commandes et variables d’environnement figurent dans le [guide d’installation](../README.md).

Le serveur web expose **50 routes API et 10 routes HTML explicites**. Le simulateur API local expose **17 routes**. Les routes ajoutées automatiquement par Fastify, notamment `HEAD`, et les fichiers statiques ne sont pas comptés.

## Serveur web et pages

`apps/local-web/src/server.ts` écoute sur `127.0.0.1:3210` par défaut (`PORT` modifiable). Les dix routes suivantes servent le même `index.html` ; le routeur de `apps/local-web/web/app.ts` choisit la vue. Les fichiers compilés sont servis sous `/static/`.

| Méthode | Route | Vue actuelle |
| --- | --- | --- |
| `GET` | `/` | Accueil : scénarios, activités du mode choisi et démarrages API à réconcilier. |
| `GET` | `/wallet` | Même accueil. |
| `GET` | `/wallet/new` | Préparation et confirmation des permissions ; `?scenario_id=…` sélectionne le scénario. |
| `GET` | `/scenarios/:scenarioId` | Même formulaire de permissions, avec scénario présélectionné. |
| `GET` | `/wallet/runs/:runId` | Achats, évaluations, réponses humaines, permissions et audit du run wallet. |
| `GET` | `/simulations/:runId` | Alias de la vue de run wallet pour une simulation locale. |
| `GET` | `/wallet/profiles` | Profils comportementaux ; `?scenario_id=…` présélectionne le profil. |
| `GET` | `/documentation/filters` | Référence interactive des filtres intégrée à l’application. |
| `GET` | `/runs/:runId` | Consultation d’une inspection historique ; aucune décision de paiement. |
| `GET` | `/safety/:mandateId` | Page de compatibilité invitant à ouvrir un scénario pour revoir les permissions. |

Le choix Offline/Online est conservé dans `localStorage` (`viseca.data-mode.v1`). L’interface ajoute `?mode=local` ou `?mode=live` à ses appels API et sépare ses brouillons et commandes en attente par mode. Le serveur filtre les runs wallet et refuse l’accès à un run, une préparation ou une action de profil incompatible avec le mode demandé. `live` peut désigner le simulateur local ou l’API distante ; lire `live_environment` dans `/api/wallet/options` pour les distinguer.

L’interface utilise principalement `/api/wallet/*`, les réponses/réévaluations/annulations de `/api/simulations/*`, et `GET /api/runs/:runId` pour les inspections sauvegardées. Les autres routes restent exposées pour les intégrations et outils locaux. Le formulaire relit une préparation en cours toutes les 900 ms ; la page d’activité relit le run toutes les 1 500 ms tant qu’elle est ouverte.

## Conventions de l’API locale

- Les corps de mutation sont des objets JSON, avec `Content-Type: application/json`. Les champs inconnus sont refusés par les validateurs des routes.
- Toutes les mutations `/api/*` exigent `Idempotency-Key` : 8 à 200 caractères parmi `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `-`. Réutiliser la même clé et le même corps pour reprendre une requête interrompue.
- La déduplication de l’API d’inspection est un cache en mémoire par méthode, URL et corps. Les commandes de simulation sont enregistrées avec leur empreinte dans le stockage. Le wallet conserve les préparations, confirmations et réponses humaines pour leur reprise ; ce n’est pas un cache HTTP universel. En particulier, confirmation et réconciliation valident la présence de la clé puis utilisent l’état durable de l’opération.
- Les actions marquées **session** ci-dessous exigent le cookie `viseca_ui` et l’en-tête `X-CSRF-Token`. Les obtenir via `GET /api/wallet/session?scenario_id=…` ou `GET /api/ui-session?mandate_id=…`. La session expire après une heure et lie l’acteur au client du scénario ; elle représente un humain simulé de démonstration.
- Une mutation avec un en-tête `Origin` doit provenir du même hôte (`Host`) et d’une origine HTTP(S) valide ; sinon `403 origin_forbidden`.
- Les lectures répondent `200` sauf indication contraire. Les erreurs utilisent `{ "error": { "code": "…", "message": "…", "details": {} } }`, avec `details` facultatif. Une route `/api/*` inconnue répond `404 route_not_found` ; une autre page inconnue répond `404` texte.

### État du serveur

| Méthode | Route | Entrée | Réponse |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | `status`, `mode: "offline"`, `app_version`, disponibilité/version du pack, vérification des hashes et nombres de scénarios/tentatives. `503` si le runtime n’a pas démarré. Le champ `mode` n’est pas l’état de la connexion Viseca. |
| `GET` | `/api/live/status` | — | `configured`, `scope: "viseca_simulator"`, notice. Teste seulement la présence de `LEASH_BASE_URL` et `TEAM_API_KEY`, sans appel réseau ; pour la configuration effective, utiliser `/api/wallet/options`. |

Si le runtime n’est pas disponible, les autres routes API échouent avec `503 data_pack_unavailable`.

### Wallet : préparation, exécution et reprise

Source : `apps/local-web/src/wallet-routes.ts`.

| Méthode | Route | Entrée | Réponse / effet |
| --- | --- | --- | --- |
| `GET` | `/api/wallet/options` | — | Scénarios/instructions, `model`, `ai_configured`, `live_configured`, `live_environment: "mock" / "remote" / "disabled"`. |
| `GET` | `/api/wallet/session` | Query `scenario_id` | Émet cookie et `{ csrf, actor, mode: "human_simulation", notice }`, avec `Cache-Control: no-store`. |
| `POST` | `/api/wallet/prepare` | **Session** ; `{ scenario_id, instruction, mode: "local" / "live" }` | `202 WalletPreparation` ; décodage et construction des permissions en arrière-plan. Aucun run démarré. |
| `GET` | `/api/wallet/preparations/:id` | ID de préparation | `WalletPreparation` : état `processing`, `ready` ou `failed`, configuration, permissions, clarifications, warnings et éventuelle confirmation. |
| `POST` | `/api/wallet/preparations/:id/confirm` | **Session** ; `{ confirmed: true, parameters, mode?, amount_interpretations? }` | `{ run_id, mandate_id, mode }` ; valide les choix, confirme le mandat et démarre le run. `parameters` est un objet `SafetyParameters`, les interprétations monétaires suivent le contrat wallet. |
| `GET` | `/api/wallet/api-starts` | `mode?` | `{ starts }` : démarrages API persistés et état de reprise ; liste vide en `mode=local`. |
| `POST` | `/api/wallet/preparations/:id/reconcile` | **Session** ; `{}` | Vérifie un démarrage live déjà soumis et renvoie `{ preparation_id, run_id, start }` ; `run_id` peut être `null`. |
| `GET` | `/api/wallet/runs` | `mode?` | `{ runs: WalletRunView[] }`, filtrés par mode s’il est fourni. |
| `GET` | `/api/wallet/runs/:id` | ID local de run/session wallet ; `mode?` | `WalletRunView` : état, heure serveur, achats, évaluations, total approuvé, réservations, configuration, audit et état du transport. Le `platform_run_id` live est distinct du `run_id` wallet. |
| `POST` | `/api/wallet/runs/:id/revoke` | **Session** ; `{}` | `WalletRunView` après révocation des permissions locales ou requête de révocation live. |
| `POST` | `/api/wallet/runs/:id/human-responses` | **Session**, run live ; corps décrit ci-dessous | `WalletRunView` ; soumet la réponse humaine à une demande live après validation. |
| `POST` | `/api/wallet/runs/:id/human-responses/reconcile` | **Session**, run live ; même corps et même clé que la réponse interrompue | `{ status: "settled" / "abandoned" / "pending", result? }`. Inspecte le résultat sauvegardé sans soumettre une nouvelle décision ; `result` est une `WalletRunView` si disponible. |

Le corps des réponses live contient `authorization_id`, `decision: "approve" / "decline"` et `answers: [{ question_id, value, source_ref?, source_excerpt? }]`. Une approbation exige aussi `offer_hash` et `expected_revision`. Ces valeurs proviennent de la dernière évaluation affichée ; le serveur vérifie l’offre, la révision, les réponses requises, les permissions et le délai avant soumission.

Une préparation doit être `ready`, avoir un décodage réussi et correspondre au mode/environnement courant. Une confirmation identique retrouve son run ; des choix différents sur une préparation déjà confirmée produisent un conflit. Une instruction/limite non résolue doit être clarifiée avant confirmation. En mode local, le wallet émet automatiquement les propositions via son service de simulation ; en mode live, un worker consomme la file de l’API.

Les évaluations exposent notamment `approved`, `declined`, `awaiting_user`, `technical_hold`, `cancelled`, `expired`. Le statut d’un run et celui d’un achat sont distincts : une simulation ayant émis toutes ses propositions peut encore avoir des réponses en attente. En live, seuls les achats acceptés par la plateforme entrent dans le total approuvé ; une soumission incertaine reste à réconcilier. La révocation live peut être `revocation_pending` ou `revocation_unknown` avant confirmation.

### Profils comportementaux

Source : `apps/local-web/src/wallet-routes.ts`. `scope` vaut `local` ou `live` et doit correspondre à `mode` si celui-ci est fourni.

| Méthode | Route | Entrée | Réponse / effet |
| --- | --- | --- | --- |
| `GET` | `/api/wallet/profiles` | — | `{ profiles }` : identifiants client/scénario et nom de scénario. |
| `GET` | `/api/wallet/profiles/detail` | Query `scenario_id`, `scope` | `BehaviorProfileDashboard` : révision, profil, permissions, contrôles, revues, métriques, projections ML et préférences simples. |
| `POST` | `/api/wallet/profiles/control` | **Session** ; `{ scenario_id, scope, filter_id, context_key, action, expected_revision }` | Dashboard actualisé. `action` : `forget`, `suspend`, `resume`. |
| `POST` | `/api/wallet/profiles/feedback` | **Session** ; `{ scenario_id, scope, authorization_id, filter_id, verdict, expected_revision }` | Dashboard actualisé. `verdict` : `confirmed`, `rejected`. |

Les actions acceptent les filtres d’habitudes `C15`, `C18`, `C19`. La révision attendue est un entier positif ou nul ; une révision périmée produit `409 PROFILE_REVISION_CONFLICT`. Le client de la session doit être celui du profil.

### Configurations et simulations locales

Source : `apps/local-web/src/simulation-routes.ts`. Les objets renvoyés ici sont des `SafetyConfig`, `SimRun` et `Assessment`, distincts des vues wallet.

| Méthode | Route | Entrée | Réponse / effet |
| --- | --- | --- | --- |
| `GET` | `/api/ui-session` | Query `mandate_id` | Session humaine liée au client du mandat ; même format que `/api/wallet/session`. |
| `GET` | `/api/mandates/:id/safety-configs` | ID de mandat | `{ configs: SafetyConfig[] }`. |
| `POST` | `/api/mandates/:id/safety-configs` | `{}` | `201 SafetyConfig` proposée à partir du mandat. |
| `POST` | `/api/safety-configs/:id/confirm` | **Session** ; `{ parameters, reviewed_requirement_ids: string[] }` | `SafetyConfig` confirmée après validation des paramètres et exigences. |
| `GET` | `/api/safety-configs/:id/export` | Configuration confirmée/exécutable, mandat actif de même version | JSON en pièce jointe `viseca-binding.json` : config, scénario, règles, hash historique, version du pack, `live_mandate_id: null`. |
| `GET` | `/api/simulations` | — | `{ runs: SimRun[] }`. |
| `POST` | `/api/simulations` | `{ config_id }` | `201 SimRun`, issu d’une configuration confirmée et d’un mandat actif. |
| `GET` | `/api/simulations/:id` | ID de simulation | `SimRun`, avec achats, évaluations, réponses, engagements, réservations et audit. |
| `POST` | `/api/simulations/:id/next` | `{}` | `{ run, assessment }` ; émet et évalue la prochaine proposition. `assessment: null` lorsque les propositions sont épuisées. |
| `POST` | `/api/simulations/:id/config` | **Session** ; `{ config_id }` | `SimRun` après application d’une configuration confirmée compatible. |
| `POST` | `/api/simulations/:id/authorizations/:authorizationId/reassess` | `{ expected_revision }` | `{ run, assessment }` après nouvelle évaluation ; révision entière obligatoire. |
| `POST` | `/api/simulations/:id/authorizations/:authorizationId/human-responses` | **Session** ; `expected_revision`, `offer_hash`, et réponse unique ou liste `answers` | `{ run, assessment }` ; valide les preuves/confirmations puis réévalue. |
| `POST` | `/api/simulations/:id/authorizations/:authorizationId/cancel` | **Session** ; `{}` | `SimRun` après refus/annulation par le client ; un achat déjà approuvé ne peut pas être annulé par cette route. |
| `POST` | `/api/simulations/:id/authorizations/:authorizationId/extractions` | `{ retry?: boolean }` | `202`, job d’extraction des détails marchands pour les champs demandant une preuve. Seule la valeur `true` active le retry. |
| `GET` | `/api/offer-extractions/:id` | ID du job | Job avec `status`, `input`, `result`, `error` ; `null` si absent. États : `processing`, `completed`, `failed`, `interrupted`. |

Pour une réponse unique, fournir `question_id`, `value`, `source_ref?`, `source_excerpt?` au même niveau que `expected_revision` et `offer_hash`. Pour plusieurs réponses, fournir `answers: [{ question_id, value, source_ref?, source_excerpt? }]` ; ne pas mélanger les deux formes. Les réponses sont liées à l’offre, à la révision et au client authentifié par le serveur.

### API d’inspection et mandats locaux

Source : `apps/local-web/src/routes.ts`. L’API d’inspection reste disponible, mais son mode ne rend aucune décision métier. Le moteur de simulation et le wallet utilisent leurs routes ci-dessus.

`PolicyContent` contient `instruction`, `hard_rules`, `uncertainty_policy` (`ask`, `decline`, `approve`), `guidance: string[]`, `open_questions: string[]`.

| Méthode | Route | Entrée | Réponse / effet |
| --- | --- | --- | --- |
| `GET` | `/api/scenarios` | — | `{ scenarios }` : scénarios et résumés de leurs données. |
| `GET` | `/api/scenarios/:scenarioId` | Query facultative `draftId`, `mandateId` | Détail du scénario, instruction, client/carte et sélection de permissions. |
| `GET` | `/api/scenarios/:scenarioId/instruction-decoding` | — | Vue du décodage : configuration, modèle, état, résultat et erreur. |
| `POST` | `/api/scenarios/:scenarioId/decode-instruction` | `{ retry?: boolean }` | `InstructionDecoding` de l’instruction du scénario ; attend la fin du décodage. |
| `POST` | `/api/mandate-drafts` | `scenario_id` + `PolicyContent` + `instruction_decoding_id?` | `201 PolicyDraft`. L’instruction doit correspondre au scénario ; l’éventuel décodage doit être terminé et lié à ce scénario. |
| `GET` | `/api/mandate-drafts/:draftId` | — | `PolicyDraft`. |
| `POST` | `/api/mandate-drafts/:draftId/confirm` | `{ confirmed: true }` ; **session si connexion live configurée** | `201 MandateRecord` actif. Un brouillon déjà confirmé retrouve son mandat. |
| `GET` | `/api/mandates/:mandateId` | — | `MandateRecord`. |
| `PATCH` | `/api/mandates/:mandateId` | `expected_version` + champs modifiables ; **session si connexion live configurée** | Mandat versionné ; champs possibles : `hard_rules`, `uncertainty_policy`, `guidance`, `open_questions`. Champs omis conservés. |
| `DELETE` | `/api/mandates/:mandateId` | Aucun corps requis ; **session si connexion live configurée** | Mandat révoqué, simulations concernées révoquées et inspections concernées annulées. |
| `POST` | `/api/runs` | `{ scenario_id, mandate_id, mode: "inspection" }` | `201 RunView`, mandat actif lié au scénario et snapshot conservé. Tout autre mode produit `409 analysis_not_configured`. |
| `GET` | `/api/runs` | — | `{ runs }`, résumés des inspections. |
| `GET` | `/api/runs/:runId` | — | `RunView` : run, compteurs, budget, total approuvé et autorisations émises. |
| `POST` | `/api/runs/:runId/next` | `{}` | Prochaine autorisation d’inspection et vue courante ; `authorization: null` après épuisement. |
| `GET` | `/api/runs/:runId/authorizations/:authorizationId` | — | `AuthorizationRecord` appartenant au run. |
| `POST` | `/api/runs/:runId/authorizations/:authorizationId/resolve` | Objet dont les seuls champs admis sont `decision`, `expected_revision`, `customer_message` | Après validation du run/achat, `409 analysis_not_configured` : aucune résolution dans ce mode. |
| `POST` | `/api/runs/:runId/cancel` | `{}` | `RunView` annulée ; achats en attente annulés localement. |

Le PATCH exige `expected_version >= 1`, ne change pas l’instruction et doit conserver toutes les anciennes règles sans modification. Les listes fournies remplacent les précédentes. Les snapshots d’anciens runs restent inchangés.

### Principales erreurs locales

| Statut | Situations |
| --- | --- |
| `400` | Corps/champ/ID invalide, mode invalide, clé d’idempotence manquante ou invalide. |
| `403` | Origine interdite, session/CSRF absent, client différent du propriétaire. |
| `404` | Ressource introuvable, achat absent du run, ressource wallet d’un autre mode. |
| `409` | Révision/version périmée, clé réutilisée avec un contenu différent, état incompatible, préparation non prête, mandat révoqué, réponse expirée, résultat distant encore incertain. |
| `413` / `415` | Corps trop volumineux / type de contenu non pris en charge. |
| `422` | Politique, paramètres ou confirmation invalide selon la route. |
| `500` / `503` | Erreur interne / runtime ou dépendance indisponible selon le service. |
| `502` / `504` | Échec de communication/décodage externe ou délai de décodage dépassé. |

Une décision métier de refus peut être une réponse HTTP `200` : consulter les états métier du résultat.

## API Viseca et simulateur local

Le navigateur n’appelle pas directement `/v1/*`. `VisecaClient` (`packages/local-runtime/src/simulation/viseca-client.ts`) les appelle côté serveur, avec `Authorization: Bearer …`, `Accept: application/json` et, pour les POST, `Content-Type: application/json`. L’URL et le jeton proviennent de `LEASH_BASE_URL` et `TEAM_API_KEY` ; l’URL doit être HTTPS, ou HTTP sur une adresse de loopback. Les redirections sont refusées.

Le simulateur `apps/api-mock/src/app.ts` implémente les **17 couples méthode/route** suivants sur `127.0.0.1:4313` par défaut (`API_MOCK_PORT`). Il exige `Bearer local-viseca-test` sauf pour `/healthz`, et ajoute `X-Viseca-Mode: local-contract-emulator`. Le tableau décrit son contrat implémenté. Les 12 lignes marquées **Client** sont les routes réellement utilisées par `VisecaClient` ; le laboratoire `apps/api-lab` accède aussi aux données de référence et permet les requêtes explicites autorisées. Le comportement hébergé n’est pas garanti par l’émulateur.

| Méthode | Route | Utilisation | Entrée et résultat du mock |
| --- | --- | --- | --- |
| `GET` | `/healthz` | Santé mock | Sans clé ; `{ status, version, mode: "mock", emulation: true }`. |
| `GET` | `/v1/bootstrap` | **Client**, laboratoire | Versions, scénarios, profil de contrat, timeouts, limites et fonctionnalités. |
| `GET` | `/v1/reference-data` | Laboratoire | Catalogues, taux de change et métadonnées de l’historique. |
| `GET` | `/v1/reference-data/authorization-history.csv` | Laboratoire | Fichier CSV d’historique, `text/csv`. |
| `POST` | `/v1/mandates` | **Client**, laboratoire | `PolicyContent` seul, sans identités ni `scenario_id` ; `201`, brouillon avec `draft_id`. |
| `POST` | `/v1/mandates/:id/confirm` | **Client**, laboratoire | `:id` est le `draft_id` ; `{ confirmed: true }` ; mandat actif avec `mandate_id`. |
| `GET` | `/v1/mandates/:id` | **Client**, laboratoire | `:id` est le `mandate_id` ; mandat complet. |
| `PATCH` | `/v1/mandates/:id` | Requête explicite du laboratoire | `hard_rules?`, `uncertainty_policy?`, `guidance?`, `open_questions?` ; mandat actualisé. Pas d’`expected_version` dans ce contrat mock. |
| `DELETE` | `/v1/mandates/:id` | **Client**, laboratoire | Révoque le mandat et retourne son état. |
| `POST` | `/v1/scenario-runs` | **Client**, laboratoire | `{ scenario_id, mandate_id }` ; `201`, run et compteurs. Un seul run actif dans le mock. |
| `GET` | `/v1/scenario-runs/:id` | **Client**, laboratoire | Run, snapshot du mandat, profils de fixture, progression et compteurs. |
| `GET` | `/v1/decision-requests/next` | **Client**, requête explicite du laboratoire | Query `wait` de 0 à 25 secondes, client : `wait=25`. `200` avec enveloppe `{ run_id, event_id, authorization_id, data: AuthorizationEvent, … }`, ou `204` vide. |
| `POST` | `/v1/authorizations/:id/decision` | **Client**, laboratoire | `{ authorization_id, decision: "approve" / "decline" / "step_up", reason_codes?, customer_message?, evidence?, engine_version? }` ; état public de l’autorisation. |
| `POST` | `/v1/authorizations/:id/resolve` | **Client**, laboratoire | `{ decision: "approve" / "decline", authorization_id?, reason_codes?, customer_message?, evidence? }` ; réponse humaine après `step_up`, état public de l’autorisation. |
| `GET` | `/v1/authorizations` | **Client**, laboratoire | `{ data: […] }`, filtre mock facultatif `run_id`. Le client lit le registre de l’équipe sans ce filtre. |
| `GET` | `/v1/events` | **Client**, laboratoire | Query `since` facultative (curseur, `0` initial) ; `{ data: […] , next_cursor }`. |
| `POST` | `/v1/team/reset` | Mock seulement dans ce dépôt | Réinitialise mandats, runs, autorisations, file et événements ; `{ reset: true, next_cursor: "0" }`. Le laboratoire bloque cette route, le client wallet ne l’appelle pas. |

Le client crée le brouillon avec l’instruction et les règles confirmées, `uncertainty_policy: "ask"`, `guidance: []`, `open_questions: []`. Il confirme avec `{ confirmed: true }`, puis démarre avec `{ scenario_id, mandate_id }`. Le worker transmet `reason_codes`, `customer_message`, `evidence`, `engine_version` pour une décision automatique. Pour une résolution humaine, il transmet l’identifiant, le choix et les preuves, sans `engine_version`.

Le long polling **consomme une livraison** de la file de l’équipe, même si la méthode est GET. Une seule consommation simultanée est autorisée dans le mock (`409 queue_consumer_exists`). Un `204` signifie qu’aucun événement n’a été livré pendant l’attente, pas que le run est terminé. Le client valide `data` contre `data/schemas/authorization_event.schema.json` et vérifie les identifiants de l’enveloppe. La réconciliation lit le registre et le flux d’événements ; elle suit `next_cursor` jusqu’à stabilisation, avec une limite de 100 pages et 10 000 événements.

Le mock utilise par défaut une fenêtre automatique de 8 000 ms et une fenêtre humaine de 120 000 ms, annoncées par bootstrap. Après `step_up`, l’état est `awaiting_human`; expiration ou refus donnent `declined`, approbation `approved`. Avec `API_MOCK_CONTRACT_PROFILE=railway`, les états exposés incluent `awaiting_customer`, `timed_out` et `is_final`, et un `/resolve` contenant `engine_version` répond `422 unsupported_resolve_fields`. Ce sont des profils de simulation locaux.

Dans le mock, répéter une décision/résolution avec le même corps retrouve l’état ; un corps contradictoire produit `409`. Il n’exige pas `Idempotency-Key`. La révocation conserve les achats déjà en file ou en attente humaine et bloque les nouveaux achats concernés. Le PATCH conserve les anciennes règles intactes et ne peut changer l’incertitude que vers `decline`. Les erreurs du mock utilisent `{ error: { code, message } }`.

## Appel externe de décodage

Les décodeurs `packages/local-runtime/src/ai/openai-instruction-decoder.ts` et `packages/local-runtime/src/ai/offer-extraction.ts` appellent **`POST https://api.openai.com/v1/responses`** côté serveur avec `OPENAI_API_KEY`. Ils demandent une sortie JSON structurée (`text.format`, schéma strict) et `store: false`. L’un transmet l’instruction pour préparer les permissions ; l’autre transmet les sources de détails marchands et les champs de preuve demandés. Les sorties sont validées localement avant utilisation. Le choix `mode=local` concerne les achats et ne désactive pas, à lui seul, ces appels de décodage.
