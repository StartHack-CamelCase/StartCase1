# Structure de données

Cette page décrit les données utilisées par le code actuel : pack CSV, permissions, achats évalués, profils comportementaux et stockage local. Les définitions complètes sont dans [packages/contracts/src](../packages/contracts/src/index.ts) ; les schémas du pack et les types applicatifs ont des rôles distincts.

## Pack de référence

Le dossier [data](../data/README.md) contient le pack synthétique `saw26`, fourni avec le challenge. Son [dictionnaire](../data/data_dictionary.md) précise les colonnes et leur sémantique. [metadata.json](../data/metadata.json) référence 18 fichiers avec leurs empreintes SHA-256, dont les deux documents du pack.

| Fichier | Lignes | Clé et relations principales |
| --- | ---: | --- |
| `customers.csv` | 20 | `customer_id` ; contexte et préférences de la persona |
| `accounts.csv` | 31 | `account_id` → `customer_id` ; devise, statut et limites du compte |
| `cards.csv` | 41 | `card_id` → `account_id` ; statut, dates et capacités de la carte |
| `merchants.csv` | 58 | `merchant_id` ; nom, catégorie, MCC, pays, ville et capacités |
| `items.csv` | 66 | `item_id` ; description et fourchettes de prix en CHF |
| `fx_rates.csv` | 4 | `from_currency` → CHF ; taux fixes CHF/EUR/GBP/USD |
| `authorization_history.csv` | 4 701 | `authorization_id` (`TR…`) → client, compte, carte et marchand |
| `scenario_catalogue.csv` | 5 | `scenario_id` ; instruction, thème et nombre de tentatives |
| `scenario_authorities.csv` | 5 | `authority_id` → client et carte ; validité de la fixture |
| `purchase_attempts.csv` | 45 | `authorization_id` (`AU…`) → scénario, autorité, carte et marchand |
| `purchase_attempt_items.csv` | 56 | `(authorization_id, line_no)` → tentative et `item_id` |

```text
Customer ──< Account ──< Card ──< HistoricalAuthorization
                           └──< SourceAttempt >── Scenario
                                      ├── FixtureAuthority ── Customer / Card
                                      ├── Merchant
                                      └──< SourceAttemptItem >── CatalogueItem
```

Les jointures utilisent les identifiants, jamais les noms. `scenario_authorities.csv` ne contient pas de `scenario_id` : le lien passe par les tentatives. Une autorité `AUTH…` décrit une fixture ; un mandat est une permission confirmée. `related_transaction_id` relie deux lignes historiques `TR…`, tandis que `related_authorization_id` relie deux tentatives `AU…`.

Les cinq scénarios contiennent respectivement 1, 10, 12, 11 et 11 tentatives (`SCEN0000` à `SCEN0004`). Le fichier `connection_check.json` reprend `AU0001` ; il ne constitue pas une tentative supplémentaire.

### Chargement et types normalisés

Le [loader](../packages/local-runtime/src/data/loader.ts) valide le manifeste, les empreintes, les en-têtes et nombres de lignes, les valeurs, les clés étrangères, l'identité client/carte des autorités, la chronologie et les montants. Les contrats CSV proviennent de [data_pack.schema.json](../data/schemas/data_pack.schema.json) et [authorization_history.schema.json](../data/schemas/authorization_history.schema.json).

[DataPack](../packages/contracts/src/data.ts) contient les tableaux normalisés ainsi que les index `customersById`, `accountsById`, `cardsById`, `merchantsById`, `itemsById`, `scenariosById`, `authoritiesById`, `fxByCurrency`, `attemptsByScenario`, `itemsByAttempt` et `historyByCard`. Les tentatives sont triées par `replay_order`, les paniers par `line_no` et l'historique par `(timestamp, authorization_id)`. Chaque ligne normalisée porte `source: { file, row }` pour retrouver le CSV d'origine.

- `Currency` vaut `CHF | EUR | GBP | USD`. `DecimalString`, `ISODate` et `ISODateTime` sont des chaînes ; le chargement contrôle leurs valeurs. Les dates utilisent `YYYY-MM-DD`, les timestamps ISO 8601 UTC.
- Les montants CSV restent des chaînes décimales. Les calculs et contrôles monétaires utilisent `decimal.js`, avec arrondi à deux décimales en half-even pour la conversion CHF. La devise provient de la ligne, pas du pays marchand.
- Les capacités des cartes et les indicateurs historiques sont convertis en booléens. `recurring_capable` reste `"true" | "false"`. Les conditions d'achat utilisent `"true" | "false" | "unknown" | "not_applicable"`.
- Les champs facultatifs vides deviennent `null`, notamment les appareils absents de l'historique, les dates de livraison et les références liées. Les 45 valeurs `spend_in_period_before_chf` sont absentes. Le champ CSV `fx_rates.source` devient `source_name` pour laisser `source` à la provenance.

L'historique comprend 4 565 achats, 83 retraits et 53 remboursements, du 1er septembre 2025 au 31 juillet 2026. Ses 259 refus ne sont pas des labels de fraude. Les compteurs `approved_*_before` sont calculés sur les lignes approuvées strictement antérieures de la même carte ; les remboursements réduisent la dépense. `approved_spend_before_chf` couvre tout l'historique, pas un mois. Le statut historique d'une carte est celui de la transaction, tandis que `cards.csv.status` décrit son statut courant.

## Permissions et préparation du wallet

Les contrats sont définis dans [policy.ts](../packages/contracts/src/policy.ts), [instruction-decoding.ts](../packages/contracts/src/instruction-decoding.ts) et [wallet.ts](../packages/contracts/src/wallet.ts).

| Objet | Données conservées |
| --- | --- |
| `PolicyContent` | `instruction`, `hard_rules`, `uncertainty_policy`, `guidance`, `open_questions` |
| `PolicyDraft` | Contenu, `draft_id`, `source_scenario_id`, interprétation, dates de création/mise à jour, erreurs de validation ; `compiler_version: null` |
| `MandateRecord` | Contenu confirmé, IDs du brouillon et du mandat, scénario source, version, statut `active/revoked`, dates et origine `local_user/test_script` |
| `Interpretation` | Statut `not_started/partial/reviewed`, producteur `manual/fixture/model`, versions et exigences reliées aux indices des règles ; décodage facultatif |
| `InstructionDecoding` | Variables extraites, exigences non mappées, inventaire de couverture facultatif, instruction exacte, versions, hash du schéma, modèle demandé/retourné, ID de réponse, durée et consommation de tokens |
| `WalletPreparation` | Statut `processing/ready/failed`, mode `local/live`, scénario et instruction, environnement live, décodage, configuration proposée, permissions affichées, clarifications et avertissements |

Une `HardRule` possède `field`, un opérateur parmi `<`, `<=`, `=`, `!=`, `>`, `>=`, `in`, `not_in`, et `value: number | string | string[]`. `currency`, `scope: purchase/period` et `period_days` sont facultatifs et peuvent être `null`. `uncertainty_policy` vaut `ask`, `decline` ou `approve`.

Les `DecodedVariable` distinguent `present`, `absent` et `ambiguous`, avec valeur, opérateur, devise, portée, extrait de l'instruction et note. Les champs d'interprétation et de diagnostic restent dans les données applicatives ; ils ne font pas partie du mandat canonique envoyé dans un événement.

Les clarifications du wallet portent une clé, un libellé, un type `text/number/select/items`, une valeur, un indicateur obligatoire et, si nécessaire, des options ou un diagnostic. Les interprétations monétaires distinguent `maximum`, `minimum`, `exact`, `approximate`, `range` et `description`. Une plage explicite conserve `min_order_chf` et `max_order_chf`. La confirmation mémorise l'empreinte, les paramètres confirmés, l'acteur et les IDs créés.

## Événement d'autorisation

[AuthorizationEvent](../packages/contracts/src/event.ts) correspond au [schéma JSON canonique](../data/schemas/authorization_event.schema.json). L'[exemple fourni](../data/scenario_fixtures/example_authorization_request.json) montre un objet complet ; dans le transport live, cet objet est contenu dans `data` de l'enveloppe.

| Bloc | Contenu |
| --- | --- |
| Racine | `type: authorization.request`, `request_id`, `deadline_at` |
| `authorization` | IDs runtime et source, scénario et ordre de replay, mandat/profil/carte, marchand imbriqué, timestamp simulé, montants, canal/appareil, statuts, livraison, retours, annulation, achat lié, description et `items[]` |
| `mandate` | `mandate_id`, `status`, `customer_id`, `card_id`, `instruction`, `hard_rules`, `uncertainty_policy`, `profile_id` |
| `context` | `approved_spend_in_period_chf`, `recent_authorizations[]` |
| `runtime` | `received_at`, `history_window_minutes`, `context_basis: run_decisions_and_scenario_timestamps` |

Les montants de l'événement sont des nombres JSON. Chaque article porte `line_no`, `item_id`, `item_name`, `item_category`, `quantity`, `unit_price`, `currency`, `item_details`. La description du catalogue reste séparée de ces conditions d'offre.

L'[adaptateur CSV](../packages/local-runtime/src/data/event-builder.ts) joint marchand et panier, lie le snapshot du mandat à l'identité du scénario et valide l'événement avec Ajv. Il remappe les références `AU…` vers les IDs runtime du même run. Un appareil absent devient une chaîne vide dans ce contrat. Il conserve `related_authorization_status` comme fait source.

L'adaptateur initialise `context.approved_spend_in_period_chf` à `null`. L'évaluateur local calcule les budgets à partir de son registre de dépenses et réservations ; il ne dépend pas de ce compteur de l'événement. Le mock et la plateforme live produisent leur propre contexte de décisions. `authorization.timestamp` est le temps simulé de l'achat ; `received_at` et `deadline_at` utilisent l'horloge réelle.

## Évaluation, registre et réponses humaines

[simulation.ts](../packages/contracts/src/simulation.ts) décrit les objets utilisés par l'[évaluateur](../packages/local-runtime/src/simulation/evaluator.ts) et le [service de simulation](../packages/local-runtime/src/simulation/service.ts).

| Objet | Structure et rôle |
| --- | --- |
| `SafetyConfig` | `schema_version: 1`, IDs et versions de configuration/mandat, instruction et hash, statut `draft/confirmed`, exigences, paramètres, acteur et dates de confirmation |
| `SafetyParameters` | Bornes d'achat, budgets glissants/journaliers/mensuels, devises et marchands autorisés/bloqués, catégories/pays, articles/attributs/quantités, livraison/retours/annulation, historique/appareil, signaux comportementaux, revue humaine, durée du consentement et fuseau horaire |
| `Requirement` | Extrait source, description, filtres et paramètres concernés, statut `pending/confirmed`, question, auteur et révision |
| `SimRun` | Identité et snapshot du mandat, configuration, `budget_scope_id`, statut `active/completed/revoked`, position/révision, historique et hash, achats, engagements, réservations et audit |
| `SimPurchase` | Événement canonique, historique des `assessments`, réponses humaines |
| `Assessment` | Décision, état d'exécution, complétude, possibilité de finalisation, snapshots et hashes, résultats de filtres, preuves, questions, verrou, versions, timestamps et corrélation |
| `Commitment` | Achat engagé : ID, montant CHF en chaîne, timestamp simulé, quantité et portée budgétaire |
| `Reservation` | Même structure qu'un engagement, plus hash d'offre et expiration ; capacité réservée avant décision finale |
| `AuditEntry` | Séquence, temps réel/simulé, acteur, événement, IDs achat/évaluation, filtres, détails et corrélation |

`Assessment.decision` vaut `approve | deny | step_up | null`. `execution_state` vaut `evaluating | awaiting_user | technical_hold | approved | declined | cancelled | expired`. Un `SimRun` devient `completed` lorsque toutes les propositions ont été émises ; des achats peuvent encore attendre une réponse.

Les filtres actifs sont déclarés dans `MERCHANT_FILTER_IDS`, `CUSTOMER_FILTER_IDS` et `GUARD_FILTER_IDS`. Un `FilterResult` indique le domaine, le type de contrôle, la phase (`prepare/assess/resolve/commit`), le résultat (`pass/fail/needs_review/not_applicable/not_evaluated`), la couverture et les raisons. Les `Evidence` relient chaque preuve à une source, un champ, un hash, un extrait et des valeurs observées/attendues. Les `Reason` indiquent notamment l'effet et le type de résolution attendu.

Une `Question` est liée à un fait, à des filtres et au hash de l'offre. Une `HumanAnswer` ajoute la valeur, les éventuelles preuves, l'acteur vérifié côté serveur, la révision de configuration, l'expiration et l'évaluation qui a consommé le consentement. Le `PurchaseLock` conserve le blocage `denied_version`, `pending_step_up` ou `technical_hold` et ses raisons. Une approbation crée un engagement ; une demande de revue peut réserver la capacité disponible.

### Inspection et transport live

Les [runs d'inspection](../packages/contracts/src/run.ts) utilisent un contrat séparé : `RunRecord.mode` vaut uniquement `inspection`. Leurs achats restent `pending` ou deviennent `cancelled`, avec `evaluation_status: not_evaluated`. `RunView.total_approved_chf` vaut `"0.00"`. Les identifiants sont `LOCAL_RUN_{clé}`, `LOCAL_AUTH_{clé}_{AU…}`, `LOCAL_REQ_{clé}_{AU…}` et `LOCAL_PROFILE_{clé}` ; les simulations utilisent un ID de run `SIM_{UUID}`.

Le transport live conserve un [LiveBinding](../packages/local-runtime/src/simulation/live-engine.ts) contenant la configuration confirmée, le mandat distant, le scénario, les règles, le hash d'historique et la version du pack. Chaque [LiveEntry](../packages/local-runtime/src/simulation/viseca-worker.ts) contient l'événement, le snapshot, la proposition locale, l'intention d'envoi, le résultat accepté, la réservation, la limite de réponse humaine et l'historique de transport. Ses états sont `proposed`, `intended`, `submission_unknown`, `accepted`, `deadline_missed` et `awaiting_human`. Le transport convertit `deny` en `decline`.

Les approbations acceptées par la plateforme constituent la dépense live. Les envois dont le résultat est inconnu conservent leur réservation jusqu'à réconciliation. La [session live](../packages/local-runtime/src/services/live-session-service.ts) distingue le statut du run et celui du mandat : `active`, `revocation_pending`, `revocation_unknown` ou `revoked`. `WalletRunView` projette les runs locaux et live pour l'interface : achats, évaluations, montant approuvé, réservations, audit, configuration et état du transport.

## Profils comportementaux et extractions

Les [profils](../packages/contracts/src/behavior.ts) sont isolés par `customer_id` et portée `local/live`. `BehaviorObservation` enregistre une confirmation explicite pour un filtre `C15`, `C18` ou `C19`, un contexte, un achat, un acteur, le temps simulé et le temps réel d'enregistrement. `BehaviorControlEvent` consigne `forget/suspend/resume` dans l'ordre durable du journal.

Le [BehaviorJournal](../packages/contracts/src/behavior-dashboard.ts) conserve sa version, sa séquence, les observations, contrôles et revues `confirmed/rejected`. `BehaviorProfile` projette les habitudes avec nombres de confirmations, jours distincts, poids effectif, statut et versions des paramètres. Les tableaux de bord exposent les permissions, contrôles et métriques sans remplacer les journaux d'achat.

[BehaviorMLDashboard](../packages/contracts/src/behavior-ml.ts) est une projection en mode `shadow` avec `decision_influence: false`. [SimplePreferencesDashboard](../packages/contracts/src/simple-preferences.ts) utilise `beta_bernoulli_v1` avec `observation_only: true`. Les [comparaisons comportementales](../packages/contracts/src/behavior-evaluation.ts) conservent les décisions avec/sans adaptation, l'heure de prédiction, les labels et leur date de disponibilité.

L'[extraction d'offre](../packages/local-runtime/src/ai/offer-extraction.ts) utilise `OfferExtractionInput` (`offer_hash`, sources textuelles, champs demandés) et retourne des `OfferFact` avec statut `stated/missing/ambiguous/conflicting`, valeur, unité, référence et extrait exact. `validation_required: true` accompagne chaque résultat ; cette extraction n'est pas une décision de paiement.

## Stockage local

Les chemins par défaut sont définis dans [runtime.ts](../packages/local-runtime/src/runtime.ts). Le serveur accepte `LOCAL_STATE_DIR` et `LOCAL_OUTPUT_DIR` ; les données source, l'état et les sorties doivent rester dans des dossiers distincts.

| Chemin par défaut | Contenu persistant |
| --- | --- |
| `.local-state/policies.json` | `PolicyStoreDocument { schema_version: 1, drafts, mandates }` |
| `.local-state/instruction-decodings.json` | `{ schema_version: 1, records }` ; clé, instruction, statut, résultat et erreur des décodages |
| `.local-state/offer-extractions.json` | Tableau de jobs : ID, clé, entrée, statut, résultat et erreur |
| `.local-state/simulations.sqlite` | Tables `state` (document de simulation, révision, checksum) et `commands` (clé d'idempotence, empreinte, réponse, checksum) ; inclut le journal comportemental |
| `.local-state/wallet.sqlite` | Tables `preparations` et `human_responses` ; JSON et checksum |
| `.local-state/live-mock/` ou `.local-state/live-remote/` | `live-sessions.sqlite` et un fichier `LIVE_SESSION_….sqlite` par outbox |
| `output/LOCAL_RUN_…/run.json` | Snapshot d'inspection : `schema_version`, `run`, `records`, `trace_sequence`, `traces` en version 2 |
| `output/LOCAL_RUN_…/events.jsonl` | Projection des événements d'inspection |
| `output/LOCAL_RUN_…/trace.jsonl` | Projection des traces d'inspection |
| `output/.writer.sqlite` | Verrou d'écriture des runs d'inspection |
| `.local-state/api-mock/mock-api.json` | État du serveur mock : pack, brouillons, mandats, runs, autorisations, file, événements et curseur |

Les sessions live anciennes peuvent encore être chargées directement depuis `.local-state/live-sessions.sqlite`. Le CLI live autonome utilise `.viseca/live-outbox.sqlite` par défaut, modifiable via le champ `outbox` du fichier de configuration. La commande de démonstration place ses états sous `.viseca/demo/{platform,wallet,output}`. Ces racines sont ignorées par Git.

Les [politiques](../packages/local-runtime/src/storage/policy-file-store.ts) et les fichiers JSON sont enregistrés par remplacement d'un fichier temporaire. Les stores SQLite de simulation, wallet et live utilisent WAL, une synchronisation complète et des contrôles de checksum. Les commandes de simulation sont persistées dans une transaction avec leur résultat ; rejouer la même clé et un contenu différent produit un conflit.

Le [snapshot d'inspection](../packages/local-runtime/src/storage/run-file-store.ts) est la source de vérité ; ses fichiers JSONL sont reconstruits au chargement. Un run d'inspection non terminal devient `interrupted` au redémarrage. Les simulations restent dans SQLite ; les sessions live sont restaurées avec leurs snapshots et réconciliées avec la plateforme. Les décodages et extractions interrompus sont marqués `interrupted` et nécessitent une nouvelle action explicite.
