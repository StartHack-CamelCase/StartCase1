# Intégration finale Offline / Online — 19 septembre 2026

La version principale réunit le moteur offline courant, ses profils d’apprentissage
et les protections de transport de la copie API parallèle. La copie `.parallel`
reste privée; aucune dépendance à son chemin ne subsiste dans l’application.

## Comportement livré

- Switch global Offline / Online, accessible au clavier, persistant après
  rechargement. Requêtes, brouillons, journal des commandes et profils séparés.
- Contrôles serveur du mode sur les runs, préparations et actions de profil.
  Une ancienne page ne peut pas confirmer une préparation de l’autre source.
- Permissions JSON complètes et apprentissage adaptatif conservés.
- Décisions API `/decision` et réponses humaines `/resolve`, avec délais,
  contrôle de propriétaire, offre/révision, réponses explicites et journal durable.
- Réconciliation des créations et réponses perdues sans second POST aveugle;
  maintien des réservations jusqu’à un résultat connu; montants enregistrés une fois.
- Historique API mal formé rejeté avant progression du curseur; erreurs de
  traitement exposées; clôture du run sans attente inutile d’un long-poll vide.
- Sessions de navigateur compatibles avec plusieurs onglets et plusieurs clients.
- Réintégration des corrections de parsing offline : identité marchand complète,
  récurrence structurée, négations limitées à l’engagement concerné et dimensions.

Les contraintes décodées non exécutables restent bloquantes. Une exclusion ne
peut pas être marquée couverte parce qu’une liste voisine existe; une exigence de
coupe large ou de livraison réfrigérée ne disparaît pas derrière un simple mot-clé.

## Résultats finaux

| Vérification | Résultat |
| --- | --- |
| `npm run typecheck` | Réussi |
| `npm test` | **1 129 / 1 129 tests, 66 fichiers** |
| `npm run api:test` | **20 / 20 tests**, dont transport TCP local et redirections |
| `node --test scripts/local-network-only.test.mjs` | **2 / 2 tests** |
| `npm run build` | Réussi |
| `git diff --check` | Réussi |
| Recherche des credentials privés dans les fichiers destinés à Git | Aucune fuite trouvée |

Total : **1 151 tests réussis**. Les suites API sont incluses dans les 1 129
et ne sont pas additionnées une deuxième fois. Le détail reproductible des
**2 318 requêtes de protocole**, 25 runs / 225 achats, et dix parcours du moteur
supplémentaires / 90 achats est dans [la matrice API](18_API_TEST_MATRIX.md) et
[ses résultats machine](18_API_TEST_MATRIX_RESULTS.json).

## Vérification navigateur

Instance isolée sur les ports 3214 / 4314, données synthétiques temporaires,
réseau distant bloqué :

1. Offline → Online, source explicitement identifiée comme émulateur local.
2. SCEN0000 : préparation JSON, confirmation, achat accepté CHF 20.00,
   zéro réservation et 50 contrôles visibles.
3. Retour Offline : achat API absent; rechargement conserve Offline.
4. Retour Online : achat API conservé.
5. SCEN0003 : 11 achats; un consentement explicite sur l’appareil via le bouton
   de confirmation et cinq refus humains transmis par `/resolve`.
   Résultat : CHF 841.05 approuvés, zéro demande en attente, achat à CHF 268
   refusé par le plafond CHF 250. Les six réponses apparaissent acceptées.

Cette recette exerce le navigateur et les deux serveurs TCP locaux. Elle
complète les tests Fastify injectés sans prétendre tester la latence du réseau
Viseca ni l’identité d’un vrai client.

## Contrôle du service hébergé

L’essai initial à 07:22 UTC ciblait une ancienne adresse Azure et recevait 401.
Après fourniture de la bonne origine Railway, **la même clé est valide**. Les
six lectures (`healthz`, bootstrap, références, CSV historique, autorisations,
événements) répondent 200. Les références correspondent au pack local `saw26`,
y compris les 4 701 lignes historiques.

Les parcours suivants exécutent les routes wallet et le moteur local avec le
transport HTTPS réel vers `https://leash-api-production.up.railway.app`. Le
décodage IA est désactivé pour rendre les fixtures reproductibles; les réponses
humaines sont des actions synthétiques explicites.

| Scénario | Achats | Approuvés | Refusés | Total accepté CHF |
| --- | ---: | ---: | ---: | ---: |
| SCEN0000 | 1 | 1 | 0 | 20.00 |
| SCEN0001 | 10 | 5 | 5 | 387.50 |
| SCEN0002 | 12 | 1 | 11 | 165.00 |
| SCEN0003 | 11 | 5 | 6 | 841.05 |
| SCEN0004 | 11 | 1 | 10 | 289.00 |

**45 achats, 50 contrôles par achat, aucune réservation restante.** SCEN0003
réalise six `/resolve` réels HTTP 200 : une approbation explicite et cinq refus.
La répétition identique renvoie 200 avec `idempotent_replay: true`; une réponse
contradictoire renvoie 409 `already_resolved`, sans inverser l’approbation.

Cette campagne a corrigé trois écarts de contrat : `awaiting_customer` signifie
attente humaine, `timed_out` est un refus final, et `/resolve` refuse le champ
`engine_version` qui reste valide sur `/decision`. Les deux essais de découverte
ont expiré pendant le diagnostic; ils ne sont pas comptés parmi les cinq succès.
Le premier journal a ensuite été repris : six expirations réconciliées, aucune
réservation, **zéro nouveau POST**. Aucun reset d’équipe n’a été effectué.

[Résultats machine de la campagne Railway](test-results/railway-api-2026-09-19.json).

Les credentials restent uniquement dans `.env.local` et ne sont ni copiés dans
ce rapport, ni envoyés au navigateur, ni versionnés. Voir [le guide de démarrage](../README_API.md).

## Serveur local final

Le serveur sur http://127.0.0.1:3210 a été redémarré avec le build validé.
Les **7 runs offline et 24 engagements** déjà enregistrés sont identiques avant
et après redémarrage (identifiants, statuts, empreintes historiques, montants).
Les endpoints des listes affichent 7 runs locaux et 0 live; le switch est visible
sur la version finale.
