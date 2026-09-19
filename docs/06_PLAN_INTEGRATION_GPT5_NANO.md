# Plan d'utilisation et d'intégration de GPT-5 nano

> **Périmètre révisé le 19 septembre 2026 : seul le décodage de l'instruction est mis en place.** Le plan ci-dessous est historique ; l'analyse des achats, les interfaces génériques d'analyse et les décisions restent reportées. L'implémentation utilise un unique appel Responses via `fetch` natif (sans SDK ni retries), les champs du schéma source, un cache local persistant et un résultat à relire joint au brouillon. Aucun appel ne suit « Achat suivant ». Voir le [mode d'emploi actuel](../README.md#décoder-une-instruction).

Plan préparé le 19 septembre 2026 à partir du code local et de la documentation officielle OpenAI. Il décrit le prochain travail ; aucune intégration ni requête d'inférence n'a été exécutée pour le rédiger. La clé annoncée dans `.env.local` n'a pas été lue ni testée.

## 1. Résultat visé

Ajouter deux fonctions d'assistance à l'application : préparer une proposition de mandat à partir de l'instruction exacte, puis extraire des observations des descriptions d'achat. Chaque proposition reste consultable avec ses sources, ses incertitudes et sa provenance.

Le site, les CSV et le stockage restent sur la machine. Les actions IA enverront un contenu limité à l'API OpenAI et nécessiteront Internet. Le parcours d'inspection actuel restera utilisable sans clé et sans connexion. C'est l'évolution explicite du périmètre offline pour les seules fonctions IA.

Les calculs de montants, conversions, jointures, identités, versions et transitions restent assurés par le code. Les filtres métier, scores, seuils de familiarité et stratégies d'approbation feront l'objet d'un travail distinct. Les propositions du document 05 restent des propositions.

## 2. Modèle et API

Utiliser le modèle demandé, `gpt-5-nano`, avec le SDK JavaScript officiel `openai` côté serveur et l'API Responses. Le modèle prend en charge les sorties structurées. Pour rendre les essais comparables, enregistrer le modèle retourné par l'API et prévoir le snapshot `gpt-5-nano-2025-08-07` dans la configuration. [Fiche GPT-5 nano](https://developers.openai.com/api/docs/models/gpt-5-nano).

OpenAI annonce le retrait de ce snapshot le **11 décembre 2026**. Le premier lot devra vérifier son accès sur le projet associé à la clé. Garder le modèle configurable et prévoir une nouvelle validation avant une migration ; aucun remplacement automatique par un autre modèle. [Calendrier officiel](https://developers.openai.com/api/docs/deprecations#2026-06-11-gpt-5-and-o3-model-deprecations).

Demander une réponse avec `text.format`, un JSON Schema strict et des valeurs `null` pour les informations absentes. Valider ensuite la structure avec Ajv et vérifier les références aux sources dans notre code. Le JSON conforme ne prouve ni l'exactitude de l'extraction ni la véracité des affirmations marchandes. Prévoir explicitement les refus et réponses incomplètes. [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Les appels seront indépendants, sans conversation persistante, sans outils de navigation ou d'exécution et avec `store: false`. Ce paramètre ne constitue pas une garantie de rétention nulle : les autres politiques de conservation du fournisseur s'appliquent. [Contrôles des données](https://developers.openai.com/api/docs/guides/your-data).

## 3. Usage dans les écrans

### Préparation du mandat

1. L'utilisateur choisit un scénario et enregistre son brouillon comme aujourd'hui.
2. Un bouton « Proposer une interprétation » lance un appel explicite.
3. Le serveur fournit seulement l'instruction exacte et la définition du format attendu. Il exclut les descriptions d'achats, les intitulés des scénarios et les résultats historiques de cet appel.
4. Le modèle renvoie les exigences identifiées, leurs extraits sources, des propositions structurées et les questions ouvertes.
5. L'écran affiche la proposition à côté de l'instruction. L'utilisateur peut la corriger, l'ignorer ou créer un nouveau brouillon à partir d'elle.
6. La confirmation existante reste une action explicite et crée le mandat avec sa version.

Exemple : « size 43 » peut devenir une exigence proposée de taille 43, avec cet extrait comme preuve. « A shop I use regularly » reste une exigence à préciser ; le modèle ne choisit pas un nombre d'achats ni une période de familiarité.

Une proposition IA validée techniquement est `partial`, avec `producer: model`, `model_id`, version et exigences. Le statut `reviewed` n'est attribué qu'après une revue humaine enregistrée. Les exigences non résolues restent `pending` ; aucune liste vide ne devient une permission universelle. L'acceptation dans un nouveau brouillon conserve l'auteur initial IA et trace séparément la revue humaine.

### Inspection des achats

1. Le bouton « Achat suivant » garde son fonctionnement local actuel.
2. Un bouton distinct « Extraire les informations » lance l'analyse de l'achat affiché.
3. L'appel contient toutes les lignes du panier et les descriptions de la tentative et du catalogue, avec des références séparées. Les informations personnelles, l'historique complet et les indications narratives du scénario sont exclus.
4. Le modèle propose des observations : nature du produit, taille exprimée, conditions de retour mentionnées, service additionnel, informations absentes ou contradictoires. Chaque observation référence la ligne et le champ source.
5. Un panneau présente les observations, les extraits et les questions restantes. Les montants et les valeurs structurées originales restent affichés directement depuis les données.

Le statut de l'analyse (`terminée`, `incomplète`, `en erreur`) est indépendant du statut de l'achat, qui reste **Non évalué**. Une extraction terminée ne produit ni approbation, ni refus, ni mise à jour des budgets.

## 4. Organisation proposée du code

| Emplacement | Responsabilité |
| --- | --- |
| `packages/contracts/src/analysis.ts` | Types de propositions, observations, preuves et tâches d'analyse |
| `packages/local-runtime/src/ai/config.ts` | Configuration serveur, activation et lecture des variables d'environnement |
| `packages/local-runtime/src/ai/openai-client.ts` | Adaptateur Responses, erreurs, délais et compteurs d'usage |
| `packages/local-runtime/src/ai/prompts/` | Deux prompts versionnés, maintenus dans le dépôt |
| `packages/local-runtime/src/ai/schemas/` | JSON Schemas d'interprétation et d'observation |
| `packages/local-runtime/src/services/analysis-service.ts` | Assemblage des entrées, lancement, validation, déduplication et consultation |
| `packages/local-runtime/src/storage/analysis-file-store.ts` | Tâches, résultats et métadonnées persistés atomiquement |
| `packages/local-runtime/src/services/policy-service.ts` | Création d'un nouveau brouillon issu d'une proposition et enregistrement de sa revue |
| `apps/local-web/src/` et `apps/local-web/web/` | Routes fines, états de chargement et présentation des résultats |

Les routes et les futures commandes CLI appelleront le même service. Le SDK sera importé uniquement dans l'adaptateur serveur. Les événements canoniques Viseca conserveront leur schéma ; les analyses seront stockées à côté et reliées par identifiants.

## 5. Lots d'implémentation et critères de fin

### Lot 1 — Connexion et configuration

- Ajouter une version épinglée du SDK `openai`.
- Charger `.env.local` explicitement au lancement du serveur et de la CLI IA. Les scripts actuels ne le font pas. Conserver la priorité aux variables déjà présentes dans l'environnement.
- Prévoir `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-5-nano`, un interrupteur `AI_ENABLED`, un délai technique et une limite de sortie configurables. Ne pas recopier la clé dans un exemple, un log, une réponse HTTP ou le bundle navigateur.
- Ajouter un contrôle de configuration local qui n'effectue aucun appel payant, puis une commande de test réel sur une courte entrée synthétique et le schéma utilisé par l'application.
- Choisir les paramètres de raisonnement supportés par ce modèle lors du test ; ne pas transposer ceux d'un modèle plus récent. Mesurer ensuite le compromis entre qualité et latence.

**Critère :** une réponse structurée obtenue avec le modèle demandé, son identifiant et l'usage mesurés ; erreurs de clé, accès, quota et réseau lisibles ; le site fonctionne toujours avec `AI_ENABLED=false`.

### Lot 2 — Contrats et stockage des analyses

- Créer `AnalysisJob`, `PolicyInterpretationProposal`, `PurchaseObservation` et `EvidenceReference`.
- Les identifiants des tâches, du run, de l'achat source et de l'achat d'exécution sont distincts et attribués par le serveur.
- Chaque observation comporte une valeur ou `null`, un état `stated`, `missing`, `ambiguous` ou `conflicting`, et ses références aux champs sources. `stated` signifie « affirmé dans la source », pas « certifié vrai ».
- Stocker modèle demandé/retourné, version du prompt, version du schéma, empreinte des entrées, date, durée, identifiant de réponse fournisseur, usage et résultat validé.
- Utiliser des fichiers dédiés sous `.local-state/ai/`, avec leur propre version de schéma. Garder compatibles les politiques et runs déjà enregistrés.

**Critère :** résultats retrouvés après redémarrage ; références vérifiables ; aucune modification des CSV, des événements officiels ou des anciens snapshots.

### Lot 3 — Interprétation assistée du mandat

- Définir un vocabulaire limité et documenté pour les exigences proposées. Tout champ sans sens défini reste une question ouverte.
- Ajouter le prompt d'interprétation : respecter l'instruction exacte, citer les passages, signaler ce qui est ambigu et ne pas inventer de seuil.
- Restituer les propositions dans l'écran du scénario, puis créer un nouveau brouillon sur action explicite de l'utilisateur.
- Conserver le lien vers le brouillon d'origine et l'analyse. Si une version de référence a changé, refuser l'application avec un conflit explicite.
- Adapter les validations du stockage et le service de politique pour enregistrer la provenance IA et la revue humaine. Le serveur détermine cette provenance, jamais le navigateur.

**Critère :** cinq instructions interprétables en propositions relisibles ; confirmation explicite ; ambiguïtés conservées ; instruction originale inchangée ; aucune activation automatique de règles.

### Lot 4 — Extraction des observations d'achat

- Définir les observations attendues et leurs formats, sans définir leurs conséquences sur un paiement.
- Envoyer les descriptions comme données non fiables dans le contenu utilisateur ; réserver les instructions système/développeur aux consignes de l'application.
- Ne fournir au modèle aucun outil permettant de confirmer un mandat, d'émettre un achat ou de résoudre un paiement.
- Vérifier que les extraits cités existent dans le champ source indiqué, que les lignes appartiennent au panier et que tous les éléments attendus ont un résultat, éventuellement manquant ou ambigu.
- Conserver simultanément les contradictions entre descriptions et données structurées. Une description catalogue ne comble pas implicitement une information absente de l'offre.

**Critère :** observations consultables pour les 45 achats, panier complet, descriptions injectées traitées comme du texte marchand et achats toujours « Non évalué ».

### Lot 5 — Routes, reprise et coût des appels

Routes proposées, à ajouter pendant l'implémentation :

| Route | Résultat |
| --- | --- |
| `GET /api/ai/status` | Activation et modèle configuré ; aucun secret et aucun appel réseau |
| `POST /api/mandate-drafts/:draftId/interpretations` | `202`, tâche d'interprétation persistée |
| `POST /api/runs/:runId/authorizations/:authorizationId/analyses` | `202`, tâche d'extraction pour l'achat du run |
| `GET /api/ai/jobs/:jobId` | État et résultat validé de la tâche |
| `POST /api/mandate-drafts/:draftId/apply-interpretation` | `201`, nouveau brouillon après sélection/correction explicite et contrôle de version |

Chaque mutation conserve `Idempotency-Key`. La lecture des tâches et le polling navigateur ne déclenchent pas de nouveaux appels IA. Une petite file locale dédiée évite de bloquer les services de mandat et de run pendant une requête réseau.

Persister les clés des commandes IA et associer une empreinte des entrées, du modèle, des paramètres, du prompt et du schéma aux résultats réutilisables. Les empreintes incluent les descriptions exactes : deux offres du même article avec des tailles différentes ne partagent pas leur résultat.

Au redémarrage, une tâche dont l'appel réseau était en cours devient `interrupted`. Si le fournisseur a traité la demande mais que sa réponse a été perdue, ne pas promettre une exécution distante exactement une fois ni relancer automatiquement. Une relance explicite crée une tentative liée à la précédente. Réutiliser les résultats déjà persistés lorsque les entrées sont identiques.

Gérer distinctement : indisponibilité/configuration, authentification, quota, limite de débit, délai dépassé, refus, réponse incomplète, JSON invalide et preuves invalides. Les tentatives de reprise restent bornées ; aucune de ces erreurs n'autorise un achat.

**Critère :** refresh et double clic sans appel supplémentaire pour la même commande ; état compréhensible après coupure ; aucun modèle de remplacement silencieux.

### Lot 6 — Évaluation et recette

- Tests déterministes de configuration, schémas, preuves, erreurs, idempotence et stockage avec un client simulé explicitement identifié.
- Vérifier que désactiver l'IA supprime les appels externes et conserve l'inspection complète.
- Construire des références relues manuellement pour les cinq instructions et les 45 achats. Le pack ne fournit pas de décisions métier attendues : les statuts historiques ne servent pas de vérité cible.
- Inclure les valeurs absentes, contradictions, substitutions, services additionnels et les injections des descriptions de `AU0037` et `AU0040`.
- Mesurer séparément la conformité JSON, l'exactitude des champs, la couverture des exigences/lignes, les erreurs sur les valeurs absentes, les échecs, la latence et les tokens. Une source citée correctement ne suffit pas à prouver l'exactitude sémantique.
- Effectuer une passe réelle explicite de cinq interprétations et 45 extractions, puis mesurer les répétitions utiles sur les cas ambigus. Les tests ordinaires restent sans coût d'API.
- Refaire typecheck, tests, build et parcours navigateur : proposition, correction, confirmation, extraction, erreur réseau, refresh et redémarrage.

**Critère :** rapport des résultats, erreurs connues, coût et latence mesurés ; les seuils de qualité nécessaires à une future décision métier restent à définir avec l'équipe.

## 6. Volume et coût prévisionnels

Une première passe complète représente **50 appels logiques** : cinq instructions et 45 achats, avec tout le panier dans chaque appel d'extraction. Les relances techniques, reprises et nouvelles versions peuvent augmenter ce nombre. La navigation seule ne lance pas d'appel.

Le tarif standard documenté est de **0,05 USD par million de tokens d'entrée** et **0,40 USD par million de tokens de sortie** ; l'entrée mise en cache est facturée à 0,005 USD par million. [Tarifs GPT-5 nano](https://developers.openai.com/api/docs/models/gpt-5-nano).

Exemple purement indicatif : 50 appels de 2 000 tokens d'entrée et 2 000 tokens de sortie facturés représentent environ **0,045 USD**, hors taxes, sans cache ni relance. Les tokens de raisonnement sont compris dans les tokens de sortie facturés ; il faut mesurer l'usage réel plutôt que le déduire de la longueur du JSON visible. [Usage des modèles de raisonnement](https://developers.openai.com/api/docs/guides/reasoning).

Fixer un budget technique de test et afficher le coût estimé d'une passe avant son lancement. Le délai canonique de décision de huit secondes présent dans les événements ne devient pas une promesse de latence IA ; le mode inspection ne traite toujours aucun paiement.

## 7. Ordre de livraison recommandé

1. Livrer connexion, schémas et stockage.
2. Livrer l'interprétation du mandat avec revue et confirmation, puis la valider sur les cinq instructions.
3. Livrer l'extraction par achat et ses preuves, puis parcourir les 45 achats.
4. Livrer le rapport d'évaluation, les métriques et les tests de reprise.
5. Concevoir ensuite les filtres et le moteur métier à partir des observations relues. Cette étape exigera des règles de décision explicites et des critères de qualité ; une clé API et une extraction JSON ne suffisent pas à l'activer.

Le premier résultat démontrable sera : **sélectionner un scénario → obtenir une proposition d'interprétation → la relire et confirmer un mandat → inspecter un achat → afficher les observations et leurs sources**.
