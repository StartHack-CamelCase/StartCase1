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
| `npm test` | **1 094 / 1 094 tests, 63 fichiers** |
| `npm run api:test` | **20 / 20 tests**, dont transport TCP local et redirections |
| `node --test scripts/local-network-only.test.mjs` | **2 / 2 tests** |
| `npm run build` | Réussi |
| `git diff --check` | Réussi |
| Recherche des credentials privés dans les fichiers destinés à Git | Aucune fuite trouvée |

Total : **1 116 tests réussis**. Les suites API sont incluses dans les 1 094
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

Requêtes réelles exécutées le 19 septembre 2026 à 07:22 UTC :

| Route | Résultat |
| --- | --- |
| `GET /healthz` | **200**, service `saw26-sandbox`, API `0.1.0`, pack `saw26` |
| `GET /v1/bootstrap` avec la clé configurée | **401 unauthorized** |

La clé disponible est refusée. Aucun mandat/run distant n’a été créé et aucun
reset d’équipe n’a été exécuté. La validation de `/resolve` ci-dessus est donc
celle du simulateur local. La compatibilité hébergée devra être vérifiée avec
une clé valide; elle n’est pas annoncée comme acquise.

Les credentials restent uniquement dans `.env.local` et ne sont ni copiés dans
ce rapport, ni envoyés au navigateur, ni versionnés. Voir [le guide de démarrage](../README_API.md).

## Serveur local final

Le serveur sur http://127.0.0.1:3210 a été redémarré avec le build validé.
Les **7 runs offline et 24 engagements** déjà enregistrés sont identiques avant
et après redémarrage (identifiants, statuts, empreintes historiques, montants).
Les endpoints des listes affichent 7 runs locaux et 0 live; le switch est visible
sur la version finale.
