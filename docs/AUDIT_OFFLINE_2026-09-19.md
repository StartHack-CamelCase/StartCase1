# Recette offline — 19 septembre 2026

## Résultat

Les cinq scénarios officiels et leurs 45 propositions ont été testés sans appel aux services externes. Huit défauts ont été reproduits et corrigés. La suite globale exécutée pendant cette recette a passé 589 tests dans 37 fichiers ; la validation commune suivante, exécutée par la tâche interface et vérifiée dans `/tmp/viseca-cards-final-tests.log`, passe **590 tests applicatifs dans 38 fichiers**. Un dernier test indépendant de consentement après révocation et redémarrage passe également. Les **19 tests du client API** passent avec des transports simulés ou des serveurs HTTP locaux.

TypeScript, le build de production et la vérification des 18 empreintes du pack passent. Les 45 événements canoniques sont valides. Les tests utilisent des dossiers temporaires et n'écrivent pas dans l'historique utilisateur. Le serveur principal sur le port 3210 n'a pas été redémarré par cette recette.

## Défauts corrigés

| Cas reproduit | Correction | Régression |
| --- | --- | --- |
| Canal `recurring` sans texte d'abonnement : paiement récurrent ignoré | M16 prend en compte le canal structuré | `offline-engine-audit.test.ts` |
| « No subscription » masque un abonnement sur une autre ligne ; certaines négations provoquent un faux refus | La négation reste limitée aux engagements qu'elle désigne | `offline-engine-audit.test.ts` |
| Catégorie ou MCC déclaré en contradiction avec le marchand de référence | M01 exige une revue de l'identité contradictoire | `offline-engine-audit.test.ts` |
| Écran « 27.5-inch » interprété comme « 5-inch » | Conservation de la dimension décimale, point ou virgule | `offline-engine-audit.test.ts` |
| Date de livraison impossible : exception interne | Validation explicite et erreur de configuration 400 | `offline-engine-audit.test.ts` |
| Corps HTTP trop volumineux ou format non pris en charge : erreur 500 | Conservation des statuts 413 et 415 avec messages adaptés | `offline-api-audit.test.ts` |
| Réponse humaine du mode hébergé envoyée à une simulation locale : erreur 500 | Conflit de mode explicite, statut 409 | `offline-api-audit.test.ts` |
| Panne d'écriture pendant une révocation : simulation révoquée alors que le mandat reste actif sur disque | Persistance du mandat avant mise à jour des simulations ; reprise idempotente | `offline-api-audit.test.ts` |

Les interruptions de révocation ont été injectées aux deux étapes. Après une panne survenant après la sauvegarde du mandat, le contrôle du mandat bloque de nouvelles approbations, y compris après redémarrage et soumission d'un consentement ouvert avant la panne ; la répétition de la demande termine la mise à jour des simulations. Dans cet intervalle de récupération, une lecture peut encore montrer l'ancien statut de simulation, mais les opérations vérifient le mandat révoqué et ne peuvent pas approuver un nouvel achat.

## Couverture ajoutée

- **87 tests moteur et revue indépendante** : 45 propositions × 8 configurations, soit 360 évaluations complètes des 50 filtres ; centimes, FX et arrondi, incohérences de total, références absentes, restrictions vides, limites à zéro, réservations, budget glissant, journées/mois de Zurich, changement d'heure et consentement après une révocation interrompue.
- **30 tests API et persistance** : corps invalides, origines, CSRF, autre client, concurrence, idempotence, mauvais mode, confirmation interrompue, redémarrage, corruption, révocation et erreurs de sauvegarde.
- **70 tests de scénarios** : cinq scénarios × quatre comportements humains (rejeter les demandes, confirmer seulement les risques, laisser expirer, révoquer avec demandes en attente), plus révocation avant le premier achat et 45 offres évaluées individuellement avec un registre de dépenses vide. La matrice représente **225 propositions testées, 233 évaluations et 11 650 contrôles de filtres**, avec zéro appel `fetch` ou décodeur. Elle vérifie les identifiants approuvés, les montants CHF, les réservations et les résultats après réouverture de SQLite.

Les essais indépendants des 45 offres sont utiles : dans les scénarios chaussures et écran, le premier achat épuise la quantité de mission. Les offres suivantes sont donc aussi évaluées séparément pour exercer leurs contrôles de produit, de retour, de marchand et d'injection.

Résultats détaillés : [matrice des scénarios](test-results/offline-scenario-matrix-2026-09-19.json).

## Parcours navigateur

Une instance isolée sur `127.0.0.1:3227` a été utilisée avec décodeur désactivé, clés absentes du processus de test et `fetch` serveur bloqué. Le scénario SCEN0003 a été préparé avec le parseur local.

1. JSON invalide : message explicite, aucun lancement ; JSON rétabli : confirmation et démarrage.
2. Les 11 propositions apparaissent dans les cartes horizontales ; compte à rebours visible et décroissant.
3. L'achat de CHF 165 est approuvé après confirmation explicite du risque d'appareil inconnu.
4. L'achat de CHF 232 est rejeté. Un rechargement immédiat interrompt la réception de la réponse : « Retry saved request » retrouve le résultat, sans double décision ni hausse du total.
5. Quatre autres demandes expirent sans approbation. La réévaluation d'une demande expirée ouvre une nouvelle fenêtre de 120 secondes, avec les mêmes exigences humaines.
6. La révocation avec une demande en attente retire les contrôles actifs et conserve **CHF 841.05 approuvés**, avec zéro demande restante.
7. Affichage vérifié à une largeur effective de 384 pixels : aucun débordement horizontal du document. Aucune erreur ni alerte dans la console du navigateur. La taille temporaire et l'onglet de test ont été rétablis/fermés. Le serveur de test a été arrêté et son stockage temporaire supprimé.

## Commandes et limites

```sh
AI_ENABLED=false npm test
npm run api:test
npm run typecheck
AI_ENABLED=false npm run offline:validate-data
AI_ENABLED=false npm run offline:inspect-all
```

Le build a été exécuté avec `npm run build` dans une copie des sources sous `output/offline-audit/build-workspace`, pour éviter d'interférer avec le build de l'autre tâche active. Le build utilise les dépendances déjà installées et ne requiert aucun téléchargement. Les premiers essais HTTP étaient bloqués par l'interdiction d'ouvrir un port dans le sandbox ; leur relance autorisée sur la seule interface locale a passé les 19 tests.

Le fichier `behavior.ts` et ses types manquants observés au début appartenaient à une modification parallèle en cours. Ce blocage transitoire est résolu ; les changements de cette tâche ont été préservés.

Cette recette couvre tous les scénarios fournis et les cas limites décrits ci-dessus, pas toutes les combinaisons possibles d'instructions et de preuves humaines. Elle ne valide ni les échanges avec Viseca hébergé ni les sorties futures d'un modèle IA. Le code est partagé avec d'autres tâches actives : les résultats correspondent à la version exécutée pendant cette recette.
