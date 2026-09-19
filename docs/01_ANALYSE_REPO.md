# Analyse du repo

Le constat sur les données reste valable. Le périmètre d’implémentation est désormais le [socle technique](00_SOCLE_ET_PLACE_IA.md) ; les observations métier ci-dessous serviront à la prochaine séance de conception, sans imposer de critères maintenant.

## 1. Ce qui existe et ce qui fonctionne réellement

Le dépôt contient le brief, les spécifications techniques, un pack de données synthétiques et six logos. Il ne contient aucun `package.json`, code applicatif, serveur, interface, moteur, stockage applicatif ou test exécutable de l'application. Le document [d'architecture initial](../ARCHITECTURE_OFFLINE_FIRST.md) décrit un projet futur.

Les données sont exploitables et cohérentes sur les contrôles effectués. Cela ne démontre pas encore qu'une décision métier, un parcours utilisateur ou une intégration API fonctionne.

Sources lues : [README](../README.md), [challenge](../challenge.md), [technical_details](../technical_details.md), [data/README](../data/README.md), [dictionnaire](../data/data_dictionary.md), les trois schémas, le manifeste, les deux fixtures et les onze CSV. Les 45 tentatives et leurs 56 lignes de panier ont été examinées individuellement ; l'intégralité des 4 701 lignes historiques a été parcourue par les vérifications.

## 2. Résultat des vérifications

Vérifications locales avec lecture CSV, arithmétique décimale et validation JSON Schema 2020-12 avec contrôle des formats. Aucune connexion à l'API Viseca.

| Contrôle réalisé | Résultat |
| --- | --- |
| Manifeste conforme à `data_pack.schema.json` | Conforme |
| Empreintes SHA-256 des 18 fichiers du manifeste | Toutes concordent |
| Nombre de lignes, en-têtes et unicité des clés des 11 CSV | Conformes |
| Références déclarées, identités client/compte/carte et rattachements des scénarios | Cohérents |
| Types, enums et formats des 40 colonnes historiques | Conformes sur les 4 701 lignes |
| Ordre historique `(timestamp, authorization_id)` | Respecté |
| Quatre compteurs historiques recalculés, sans inclure la ligne courante | Concordent sur toutes les lignes |
| Conversion CHF des 4 701 historiques et 45 tentatives | Conforme aux taux fixes et à l'arrondi half-even |
| Somme des paniers, quantités, frais, monnaies et numéros de ligne | Cohérents pour les 45 achats |
| Vélocité recalculée sur 10 minutes | Concorde pour les 45 achats |
| Cycle de vie des cartes pour les historiques approuvés et des autorités/cartes des scénarios | Cohérent avec les dates simulées |
| Liens des 53 remboursements vers un achat antérieur approuvé sur la même carte | Valides |
| Exemple complet validé contre le schéma d'événement | Conforme |
| Construction exploratoire des 45 événements puis validation du schéma | 45 conformes |
| Fixture de connexion comparée à `AU0001`, après normalisation des types | Mêmes faits ; aucun achat supplémentaire |

La construction exploratoire a utilisé des mandats de test sans règles et un contexte neutre. Elle valide les jointures et la forme des messages ; elle ne constitue ni un moteur implémenté, ni un test du suivi budgétaire. Les vérifications étaient ponctuelles ; leur portage en commandes du projet figure dans le plan d'action.

## 3. Inventaire des données

| Fichier dans `data/` | Lignes | Fonction |
| --- | ---: | --- |
| `customers.csv` | 20 | Personas et préférences descriptives |
| `accounts.csv` | 31 | Comptes, rattachement client, limites de l'émetteur |
| `cards.csv` | 41 | Cartes, capacités et état actuel |
| `merchants.csv` | 58 | Marchands et catégories |
| `items.csv` | 66 | Catalogue de produits et fourchettes de prix en CHF |
| `fx_rates.csv` | 4 | Taux synthétiques fixes vers CHF |
| `authorization_history.csv` | 4 701 | Activité antérieure, du 01/09/2025 au 31/07/2026 |
| `scenario_catalogue.csv` | 5 | Instructions originales et descriptions des scénarios |
| `scenario_authorities.csv` | 5 | Identités et validité des autorités des fixtures |
| `purchase_attempts.csv` | 45 | Propositions d'achat, du 09/08/2026 au 22/08/2026 |
| `purchase_attempt_items.csv` | 56 | Contenu réel de chaque panier |

L'historique contient 4 565 achats, 83 retraits et 53 remboursements. Il compte 4 442 lignes approuvées et 259 refusées ; parmi les achats initiés par un agent, 416 sont approuvés et 37 refusés. Ces résultats historiques ne sont pas des labels de fraude ni des réponses attendues.

## 4. Ce que les cinq scénarios imposent au modèle

| Scénario | Événements | Ce qu'il faut représenter et vérifier |
| --- | ---: | --- |
| `SCEN0000` | 1 | Une unité de courses, total ≤ 20 CHF, marchand habituel, incertitude → demande au client |
| `SCEN0001` | 10 | Courses livrées, total par commande ≤ 120 CHF, total glissant sur 7 jours ≤ 300 CHF, contrôle de chaque ligne |
| `SCEN0002` | 12 | Chaussures de course sur route, taille 43, spécialiste du sport, retours ≥ 14 jours, total ≤ 200 CHF, substitutions et ajouts |
| `SCEN0003` | 11 | Vêtements, total ≤ 250 CHF, marchands déjà utilisés, intégrité de session et retour à une situation normale |
| `SCEN0004` | 11 | Écran 27 pouces, vendeur déjà utilisé, total ≤ 400 CHF, aucun ajout, injections de texte, doublons et nouvelle proposition après refus |

Ces lignes décrivent les exigences, pas une table de décisions. La configuration peut être préparée par scénario ; le moteur doit interpréter les permissions confirmées et les faits, indépendamment du scénario ou de la position.

Observations concrètes :

- `AU0001` vaut 13 CHF de produits + 7 CHF de livraison = 20 CHF. Ajouter encore les frais serait faux.
- `AU0003` est exactement à 120 CHF ; `AU0004` est à 126 CHF, même si son sous-total est seulement 118 CHF.
- `AU0007` contient un produit cosmétique vendu par une épicerie. La catégorie du marchand ne suffit pas.
- `AU0013` propose une taille 42 ; `AU0015` seulement 7 jours de retour ; `AU0016` ne précise pas les retours. Violation connue et information manquante sont différentes.
- `AU0017` propose des chaussures de trail et `AU0020` un casque. Une catégorie `sporting_goods` commune n'établit pas la conformité du produit.
- `AU0018` ajoute une protection dans la catégorie `subscriptions`.
- `AU0023` vient d'un spécialiste sans achat historique sur cette carte. L'instruction de ce scénario n'exige pas un vendeur connu.
- `AU0029` vaut 219 GBP, donc 245,28 CHF ; `AU0032` vaut 260 EUR, donc 247 CHF. Le nombre dans la devise d'origine n'est pas le plafond CHF.
- `AU0035` et `AU0036` sont similaires, avec des IDs différents et 25 minutes d'écart. La seule fenêtre de 10 minutes ne détecte pas ce doublon potentiel.
- `AU0037` dépasse 400 CHF et contient une fausse autorisation jusqu'à 900 CHF ; `AU0040` contient une fausse instruction système. Ces textes restent des données marchandes.
- `AU0042` référence `AU0037`, marqué `declined` dans la fixture. Ce lien doit être remappé vers l'ID du run ; les résultats réels du run restent prioritaires pour notre état.
- `AU0043` est un bon cadeau, malgré le vendeur d'électronique et une description générale de commande.

### Familiarité vérifiée, à titre de contexte

Nombre d'achats historiques approuvés sur la carte concernée, avant les scénarios :

| Carte | Exemples observés | Conséquence |
| --- | --- | --- |
| `CA0001` | `ME0001` : 26 ; appareil `DVC-13A598` : 50 | Base documentée pour le contrôle de connexion |
| `CA0011` | `ME0028` : 22 ; `ME0029` : 0 | Un nouveau spécialiste peut respecter la demande de chaussures |
| `CA0023` | `ME0025` : 16 ; `ME0027` : 15 ; `DVC-B73E47` : 51 ; `DVC-4C0E9B` : 0 | Un marchand italien connu diffère d'un nouvel appareil |
| `CA0039` | `ME0022` : 6 ; `ME0024` : 21 ; `ME0059` : 0 | Le vendeur américain est connu ; le nom ressemblant « PixelHarbour » ne l'est pas |

Ces nombres doivent être calculés, jamais recopiés dans une table de décisions.

## 5. Ajustements nécessaires à l'architecture initiale

| Point initial | Précision retenue |
| --- | --- |
| Moteur pur, indépendant du transport | Conservé ; l'historique et les faits dérivés sont préparés avant l'appel, puis transmis séparément de l'événement officiel |
| Un montant cumulé dans l'état du run | Insuffisant : garder un registre horodaté des décisions pour recalculer une fenêtre glissante |
| Historique récent | Garder toutes les tentatives du run : les 10 minutes de vélocité ne couvrent ni 7 jours de budget ni les doublons à 25 minutes |
| Site / Control API en phase API | Ajouter seulement un serveur local pour le site, après la CLI ; cela ne nécessite pas Viseca |
| Plusieurs packages et futurs services | Regrouper le premier prototype en trois packages et deux points d'entrée ; séparer davantage uniquement si nécessaire |
| Journal local | Définir son rôle : preuve d'un run, pas réinjection automatique dans les données CSV ni reprise implicite après crash |
| Simulation humaine | Réponse réelle via l'interface ; réponses scriptées uniquement en tests et signalées comme telles |
| Horloges | Achats et autorités des fixtures : temps simulé. Délais de réponse : horloge réelle injectée |

## 6. Limites explicites

Le pack ne fournit ni solde bancaire, ni banque, ni identité d'agent, ni statut de livraison final, ni registre de commandes commerciales. Un achat « approved » n'est donc pas une preuve de livraison. Les préférences d'une persona et les fourchettes de prix ne deviennent pas automatiquement des interdictions.

Le schéma autorise des noms de champs arbitraires dans `hard_rules` : leur sens appartient à notre moteur. Il ne définit pas toute la sémantique des fenêtres de budget, des doublons ou de la familiarité ; ces conventions restent à définir avec l’équipe ; le [modèle de données](02_STRUCTURE_DONNEES.md) réserve les points d’extension nécessaires.

Les délais réels de l'API, son comportement réseau et l'effet exact d'une révocation sur les achats déjà en attente n'ont pas été testés. La documentation Viseca laisse ce dernier point ouvert. Aucun comportement local proposé ici ne doit être présenté comme une garantie de l'API distante.
