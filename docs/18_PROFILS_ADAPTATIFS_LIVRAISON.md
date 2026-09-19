# Profils adaptatifs — livraison et recette

La page [Profiles](http://127.0.0.1:3210/wallet/profiles) permet de sélectionner
un client synthétique et l'environnement local ou Viseca. Elle présente les
permissions confirmées de ses runs, puis les habitudes d'appareil, d'horaire et de
pays marchand. Les jauges montrent deux conditions séparées : dates contributrices
et poids récent. Elles n'affichent pas de pourcentage de sécurité.

Les anciens achats, réalisés avec l'apprentissage désactivé, ne produisent pas
rétroactivement de preuves. Pour commencer, activer **Learn my confirmed habits**
dans une nouvelle préparation de permissions, puis confirmer les alertes concernées.
Les règles de budget et autres contraintes conservent leur priorité.

## Actions disponibles

- **Forget** : les preuves anciennes du contexte ne contribuent plus. Leur identité
  reste dans l'audit pour empêcher qu'un replay les fasse réapparaître.
- **Suspend** : aucune utilisation ni nouvelle confirmation positive du contexte.
- **Resume from scratch** : nouvelle génération ; les anciennes preuves restent exclues.
- **Review learned decisions** : le client peut confirmer ou contredire la pertinence
  d'un contexte utilisé pour un achat finalement approuvé. Une contradiction suspend
  ce contexte. Ce feedback mesure le résultat ; il ne renforce pas automatiquement
  le poids d'apprentissage et ne modifie pas le paiement terminé.

Chaque modification vérifie la session humaine simulée, le CSRF, le propriétaire,
la révision et la clé d'idempotence. La révision évite d'appliquer silencieusement
une action fondée sur un ancien profil. Les décisions historiques restent immuables.

Le journal d'apprentissage est une projection versionnée dans le SQLite existant.
Les confirmations acceptées, les contrôles et les vérifications explicites ont un
ordre durable. Les décisions locales approuvées alimentent le journal dans la même
transaction ; les confirmations live sont importées depuis les résultats distants
acceptés et dédupliquées. Les imports historiques ne reconstruisent pas artificiellement
un ordre de connaissance passé ; les anciens snapshots ne sont pas réécrits.

## Validité du calcul

La [note mathématique](17_VALIDATION_MATHEMATIQUE_APPRENTISSAGE.md) définit le calcul
et ses hypothèses. Les propriétés vérifiées incluent la demi-vie, la décroissance
sans nouvelles preuves, les seuils distincts, le plafond quotidien et la séparation
entre temps simulé et disponibilité du feedback.

Un défaut de fenêtre a été corrigé : une seconde confirmation du même jour ne peut
plus remplacer la première à son expiration et augmenter spontanément le score.
Les conflits de source mettent en pause l'apprentissage du profil concerné ; les
suspensions restent conservées et les contrôles ordinaires continuent. Une corruption
de l'intégrité structurelle du journal durable reste une erreur de stockage bloquante,
afin de ne jamais ignorer une restriction perdue.

Une nouvelle question live apparue après un changement de profil exige une nouvelle
réponse explicite. Le serveur ne transforme plus un ancien clic en consentement
pour des faits qui n'étaient pas affichés.

## Mesure et sélection des paramètres

Les évaluations nouvelles conservent une comparaison pure avec le moteur sans
apprentissage, avant la réponse humaine et sur le même état antérieur. La page
compte séparément les alertes supprimées et les achats devenus approuvables sans
interruption. Les reprises d'une même source ne gonflent pas les résultats.

Les taux calculés hors ligne gardent leurs dénominateurs et leurs cas inconnus.
La page indique les retours vérifiés, contredits et absents. Une absence de retour
n'est jamais traitée comme un succès ou une absence de fraude.

Commande reproductible, sans effet sur les données utilisateur :

```sh
npm run offline:learning-evaluate
```

Le corpus séparé contient 300 cas synthétiques dans chaque partition de validation
et de test, avec trois filtres, des contextes confirmés ou rejetés, des suspensions
et des règles bloquantes. Les candidats partagent la même cohorte ; la sélection
utilise uniquement la validation, puis le test chronologique réservé sert de contrôle.

Résultat observé sur la partition de test :

| Candidat | Interruptions évitées | Contextes rejetés masqués |
| --- | ---: | ---: |
| Paramètres actuels, trois jours | 60 | 0 |
| Variante rapide, deux jours | 120 | 60 |
| Variante stricte, quatre jours | 0 | 0 |

Le candidat rapide est rejeté. Les paramètres actuels sont validés **uniquement
sur cette démonstration synthétique**. `live_activation_allowed` reste `false` :
les habitudes individuelles s'adaptent automatiquement, mais ce corpus ne justifie
pas un réglage automatique des seuils de production ni une promesse de précision
antifraude. Aucune tâche planifiée d'entraînement n'est créée.

## Vérifications réalisées

- TypeScript et build réussis ; 636 tests passent dans 42 fichiers.
- Apprentissage, oubli, suspension, réactivation et feedback testés avec le véritable
  stockage SQLite et après recréation des services.
- Contrôles de session, de propriété, de révision, de replay et de paramètres invalides.
- Isolation des environnements local/live et persistance des imports live vérifiées
  hors ligne ; aucun nouvel appel au simulateur hébergé pour cette recette.
- Page ouverte dans le navigateur : permissions existantes, profils sans habitudes,
  puis profils renseignés dans une instance temporaire isolée ; Forget, Suspend,
  Resume et rechargement vérifiés, sans erreur console ni débordement mobile observé.
- Serveur principal actualisé ; checksum de l'état utilisateur, historiques et
  engagements identiques avant et après le redémarrage (sept runs conservés).

Le calcul reconstruit encore les profils depuis les observations. Aucun résultat
de charge sur 100 000 événements ni budget p99 de production n'est revendiqué.
La matérialisation optimisée du plan reste conditionnée à cette mesure.
