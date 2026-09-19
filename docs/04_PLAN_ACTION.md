# Plan d'action : socle maintenant, traitement métier ensuite

Ce plan remplace le plan précédent de moteur complet. Lire d'abord [Socle et place de l'IA](00_SOCLE_ET_PLACE_IA.md). **Les étapes A1, A2, A3, A5 et A6 sont à implémenter maintenant. L'étape A4 et toute la phase B sont reportées.** La suite attend la conception avec l'équipe. Aucun modèle de langue, règle de risque ou stratégie de décision n'est choisi.

## 1. Structure cible minimale

```text
viseca-2026/
├── data/                         # données existantes, intactes
├── assets/                       # ressources locales
├── docs/                         # cadrage et contrats
├── apps/
│   ├── offline-runner/src/       # validation et inspection CLI
│   └── local-web/
│       ├── src/                  # serveur et routes
│       └── web/                  # trois écrans simples
├── packages/
│   ├── contracts/src/           # schémas et types du socle local
│   └── local-runtime/src/
│       ├── data/                # chargement, index et événements
│       ├── services/            # brouillons, mandats, runs et état
│       └── storage/             # fichiers et mémoire
├── tests/                       # contrats, données, services et routes
├── .local-state/                # ignoré par Git
├── output/                      # ignoré par Git
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── pnpm-lock.yaml
└── vitest.config.ts
```

Les applications appellent les mêmes services locaux. Les contrats restent indépendants du serveur. Les responsabilités données, permissions, runs et présentation sont séparées, sans interface d'analyse anticipée, système de plugins dynamique ni microservices.

Conserver TypeScript strict, Node épinglé, pnpm, Ajv 2020 avec formats, `csv-parse`, calcul décimal, Vitest et logs structurés. Fastify sert l'interface et les routes locales. Le frontend peut rester en HTML/CSS/TypeScript. Aucun runtime d'inférence n'est installé par anticipation.

## 2. Phase A — À construire maintenant

### A1. Contrats et workspace

Initialiser le projet, les scripts et les types du pack. Définir les objets locaux de brouillon, mandat, run, statut d'inspection et audit. Préserver le schéma officiel des événements ; les métadonnées d'interprétation restent à côté.

**Critère :** typecheck et tests de schéma passent ; les interfaces n'imposent aucun modèle ou seuil métier.

### A2. Données, jointures et inspection

Charger les onze CSV, valider types/relations/totaux et construire les index. Conserver chaque description avec son origine. Construire les 45 événements avec un snapshot explicitement fourni et des IDs propres à chaque run. Les exemples de mandat utilisés en tests sont des fixtures, pas une extraction IA.

**Critère :** 45 événements conformes ; textes, valeurs absentes, panier complet et références conservés ; nouvelle exécution sans collision d'IDs. Les 18 hashes du manifeste restent inchangés.

### A3. Brouillons et mandats sans transcription automatique

À la sélection d'un scénario, copier exactement l'instruction dans un brouillon `not_started`. Ajouter la saisie manuelle, la provenance, les exigences non interprétées, les versions et la persistance. Préparer la confirmation pour inspection et la révocation. Une instruction conservée n'est pas une instruction automatiquement comprise.

**Critère :** refresh et redémarrage retrouvent les données ; aucune règle n'est inventée ; un mandat incomplet ne peut pas démarrer une évaluation automatique. Un tableau `hard_rules` vide ne vaut pas autorisation universelle.

### A4. Reportée : interfaces et orchestration d'analyse

Ne pas brancher maintenant `PolicyInterpreter`, `PurchaseAnalyzer` ou `DecisionEvaluator`, ni ajouter de modèle, de double d'analyse ou d'infrastructure d'inférence. Le socle conserve des responsabilités séparées entre données, permissions, runs et présentation afin que ces interfaces puissent être conçues et ajoutées plus tard sans modifier les données source.

**Critère du présent travail :** le mode inspection affiche explicitement `not_evaluated` / « Non évalué ». Une règle vide signifie « non interprété » et aucune absence d'analyse ne devient une approbation.

### A5. Runs d'inspection et site local

Implémenter les routes du [parcours](03_ROUTES_ET_PARCOURS.md) avec le mode `inspection` par défaut : choix du scénario, revue du mandat, inspection successive des achats. Afficher « Analyse non configurée » et conserver les traces. Dédupliquer les commandes et les émissions. Préparer les contrats de résolution, avec les actions de paiement désactivées tant que le mode d'évaluation n'est pas disponible.

**Critère :** les trois écrans utilisent réellement les services et les données ; refresh, navigation directe et répétition d'une requête fonctionnent ; aucune analyse factice ne se présente comme une décision.

### A6. Vérification et livraison du socle

Tester contrats, jointures, montants, conservation des descriptions, snapshots, persistance, idempotence, versions périmées et redémarrage. Vérifier que le mode d'analyse est indisponible et qu'aucune décision n'est produite. Faire un parcours navigateur offline et documenter les commandes exactes.

**Critère :** le socle est utilisable sans Internet après installation/build, les cinq scénarios sont inspectables et les points de branchement IA/métier sont clairement identifiés. Ne pas annoncer « moteur métier terminé ».

## 3. Phase B — À définir avec l'équipe, hors implémentation actuelle

| Sujet | Décision à prendre ensemble |
| --- | --- |
| Interfaces d'analyse (ancienne A4) | Contrats, orchestration, versions, validation des sorties et doubles de test explicites |
| Instruction → mandat | Formulaire, extraction LLM ou combinaison ; couverture des exigences et revue humaine |
| Modèle d'IA | Modèle, exécution locale, latence, capacité, versionnement et évaluation de la qualité |
| Description → faits | Taille, couleur, type de produit, retours, contradictions, preuves et données absentes |
| Vérifications métier | Prix, limites, conformité, ajout non demandé et portée de chaque règle |
| Contexte comportemental | Familiarité, fréquence du marchand, appareil, session et historique pertinent |
| Répétitions et budgets | Distinction doublon/redevis, fenêtres et approbations tardives |
| Décision | Combinaison des vérifications, priorités, incertitude et intervention humaine |
| Qualité | Cas d'essai avec explications attendues et décisions validées par l'équipe |

Le passage en `evaluation` nécessite des modules configurés, une politique revue et une couverture suffisante des exigences. Il active les décisions, les délais et les résolutions de paiement. Ces mécanismes pourront être testés techniquement auparavant avec des doubles, mais pas présentés comme une analyse métier réelle.

## 4. Commandes du socle

Ces commandes sont implémentées dans le workspace local :

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm offline:validate-data
pnpm offline:inspect --scenario SCEN0000
pnpm offline:inspect-all
pnpm build
pnpm start:local
```

La CLI d'inspection utilise un mandat de simulation explicitement étiqueté ou un mandat local fourni ; elle n'en extrait pas les permissions. L'interface conserve les choix manuels du client avec leur provenance. Les scripts d'évaluation métier viendront en phase B.

## 5. Résultat attendu à la fin de la phase A

Un site local propre, les données correctement chargées, des brouillons et mandats persistés, des achats consultables avec leurs descriptions et un registre fiable. Les responsabilités du code sont séparées pour permettre d'ajouter les analyses dans un travail ultérieur. Aucun LLM choisi, aucune politique arbitraire de risque et aucune promesse de décision intelligente déjà implémentée.

L'API Viseca, un déploiement cloud et une base distante restent hors périmètre. Le prompt précédent demandant de coder immédiatement tout le moteur est remplacé par cette phase A.
