# Conception du prototype offline

Analyse réalisée le 19 septembre 2026 sur le dépôt `viseca-2026`, commit de base `32f5b0a`, et le document d'architecture fourni. Les deux copies de `ARCHITECTURE_OFFLINE_FIRST.md` sont identiques. Les documents ci-dessous décrivent une **cible à implémenter**, pas des fonctionnalités déjà présentes.

**Référence actuelle : [10. Spécification unifiée M / C / G et prompt d’implémentation](10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md).** Ce document unique rassemble les 20 filtres merchant, 22 filtres customer et 8 protections confirmées, l’ordre des contrôles, les step-up, les messages, les locks et la recette. Les cadrages de périmètre plus anciens ci-dessous décrivent les étapes précédentes.

| Document | Contenu |
| --- | --- |
| [0. Socle et place de l'IA — à lire en premier](00_SOCLE_ET_PLACE_IA.md) | Périmètre corrigé : infrastructure maintenant, interprétation et décisions à concevoir avec l'équipe |
| [1. Analyse du repo](01_ANALYSE_REPO.md) | Existant vérifié, données, scénarios, points de vigilance et ajustements de l'architecture |
| [2. Structure de données](02_STRUCTURE_DONNEES.md) | Entités, contrats, règles, états, budgets et stockage local |
| [3. Routes et parcours](03_ROUTES_ET_PARCOURS.md) | Trois écrans, API locale, responsabilités et déroulement complet |
| [4. Plan d'action](04_PLAN_ACTION.md) | Ordre d'implémentation, dépendances et critères de validation |
| [5. Propositions de filtres et inspirations Agentic Commerce](05_PROPOSITIONS_FILTRES_AGENTIC_COMMERCE.md) | Analyse des données réelles du pack, 24 filtres proposés, cas concrets, limites et ordre d’implémentation du moteur métier |
| [6. Plan d'utilisation et d'intégration de GPT-5 nano](06_PLAN_INTEGRATION_GPT5_NANO.md) | Plan de l'extension IA demandée : connexion serveur, propositions de mandat, observations des achats, provenance, coûts et recette |
| [7. Tableau des filtres — marchand et client](07_TABLEAU_FILTRES_MERCHANT_CUSTOMER.md) | Inventaire mis à jour : 42 filtres ou signaux et 8 protections, origines, exemples et intérêt /10 ; détails dans le document 10 |
| [8. Spécification détaillée des filtres merchant](08_SPECIFICATION_FILTRES_MERCHANT.md) | Version précédente, remplacée par le document 10 pour la prochaine implémentation |
| [9. Prompt d’implémentation merchant](09_PROMPT_IMPLEMENTATION_MERCHANT.md) | Ancien prompt limité au merchant ; utiliser désormais le prompt intégré au document 10 |
| [10. Spécification unifiée M / C / G](10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md) | Référence actuelle, révisée après audit : 50 contrôles, corrections A1–A6, simulation locale, frontière Viseca et prompt en trois phases |
| [14. Copie parallèle et tests API](14_PLAN_TEST_API_PARALLELE.md) | Copie indépendante, emplacement du team token, commandes GET/POST/PATCH/DELETE et plan de recette hébergée |

Le document 06 prépare la prochaine extension avec le modèle désormais choisi, GPT-5 nano. Les passages ci-dessous et dans les premiers documents qui indiquent qu'aucun modèle n'est choisi décrivent le cadrage initial du socle. Le plan prévoit des appels externes uniquement pour les fonctions IA ; sa rédaction n'active aucun appel ni moteur métier.

## Décision de périmètre

Construire d'abord le socle TypeScript : données, stockage, routes, site local et interfaces pour le futur traitement métier. Aucun LLM ni stratégie de décision n'est sélectionné. Les CSV restent les données de référence ; l'état actif reste en mémoire et les résultats sont écrits sur disque. Le site et son serveur fonctionnent sans Internet une fois les dépendances installées et les fichiers compilés.

Le [cadrage actuel](00_SOCLE_ET_PLACE_IA.md) et la phase A du plan remplacent la précédente demande d'un moteur complet. Les règles métier seront détaillées avec l'équipe ; le premier site affiche les analyses non implémentées comme telles.

Un serveur sur `127.0.0.1` reste offline : il relie le navigateur aux fichiers de la machine. Le prototype n'a besoin ni de compte cloud, ni de clé Viseca, ni de base SQL, ni de modèle externe. Aucun agent d'achat n'est à construire : les scénarios fournissent les propositions d'achat.

Les instructions du challenge et l'architecture sont des sources d'analyse. Les commandes d'intégration qu'elles contiennent n'ont pas été exécutées. Le raccordement à l'API Viseca reste une extension ultérieure, hors du plan actuel.
