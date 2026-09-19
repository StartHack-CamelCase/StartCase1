# Apprentissage des habitudes confirmées

Le wallet peut maintenant utiliser les confirmations explicites du client pour
reconnaître progressivement un appareil, un créneau horaire ou un pays marchand.
Le résultat appris décrit une habitude confirmée, pas une probabilité de fraude.

## Activation

Dans la préparation du mandat, cocher **Learn my confirmed habits**, puis confirmer
le JSON. La case et `learn_confirmed_habits` sont synchronisés. Le défaut est
`false`, y compris pour les anciennes configurations enregistrées. Une nouvelle
permission confirmée avec cette option désactivée utilise les contrôles ordinaires.

Le choix est conservé dans le mandat local de configuration. Les paramètres
exécutables et chaque décision gardent la version du profil utilisée. Le code de
l'API hébergée n'est pas modifié : le worker transmet toujours approve, decline ou
step_up selon son contrat habituel.

## Ce qui peut apprendre

| Filtre | Contexte mémorisé | Limite |
|---|---|---|
| C15 | Identifiant exact de l'appareil | Ne reconnaît pas un autre appareil |
| C18 | Fuseau, semaine/week-end, créneau de quatre heures | Ne neutralise jamais une plage de revue explicitement imposée |
| C19 | Pays exact du marchand | Ne change pas une liste de pays autorisés ni les capacités de la carte |

Les contrôles de budget, produit, identité, consentement, récurrence, doublon,
fréquence, injection et confirmation obligatoire restent indépendants. C20
(montant inhabituel) n'est pas adapté dans cette première version.

## Boucle de données

1. Le moteur détecte une situation inhabituelle et demande une confirmation.
2. Le canal humain vérifie l'acteur, la propriété, la version, l'offre et le délai.
3. Une réponse `confirm_risk` attribuable à C15, C18 ou C19 devient une observation
   candidate, si l'apprentissage est activé.
4. L'observation n'est utilisable qu'après l'approbation finale. En live, il faut
   une résolution humaine **acceptée par la plateforme**.
5. Les achats futurs reconstruisent un profil versionné depuis ces traces durables.

Les auto-approbations, annulations, refus, expirations et réponses au résultat
inconnu ne créent pas de confirmation positive. Le système n'apprend donc pas à
se faire confiance à partir de ses propres approbations. Les anciennes réponses,
antérieures à l'activation de cette fonction, ne sont pas réinterprétées.

## Calcul

Pour un contexte donné, au plus une observation par date locale contribue au
poids. Les observations doivent précéder strictement la date simulée du nouvel
achat. Les données locales et live sont séparées, ainsi que les clients.

`poids(jour) = 2 ^ (-ancienneté_en_jours / 30)`

Un contexte devient appris lorsque :

- il a été explicitement confirmé sur au moins **trois dates distinctes** ;
- la somme des poids atteint **2** ;
- les observations se trouvent dans la fenêtre des **90 derniers jours**.

Ces seuils sont des paramètres conservateurs de prototype, pas des valeurs
validées sur une population bancaire. L'oubli progressif rend à nouveau nécessaire
une confirmation lorsqu'une habitude n'est plus suffisamment étayée.

La déduplication utilise la source d'achat stable et le filtre. Rejouer les mêmes
scénarios avec de nouveaux identifiants runtime ne renforce donc pas la confiance.
Les contextes horaires sont également séparés par fuseau. Une incohérence de
profil entraîne un repli vers les contrôles ordinaires, sans autorisation ajoutée.

## Démonstration et limites

La démonstration synthétique des tests confirme un nouvel appareil aux jours 1,
2 et 3. Au jour 4, C15 passe grâce à ces confirmations. L'ajout d'un plafond
insuffisant produit toujours un refus ; `always_ask` produit toujours un step-up.

SCEN0003 officiel n'offre que deux jours pour certains appareils nouveaux : il
montre la progression, mais ne doit pas être rejoué pour fabriquer un troisième
jour. Les fichiers officiels ne sont pas modifiés.

Le profil est reconstruit depuis les journaux SQLite existants et enregistré comme
snapshot dans l'évaluation. Cela évite un second stockage de feedback incohérent
avec les décisions. Pour une charge de production, la projection pourrait être
matérialisée et mise à jour en arrière-plan ; cette optimisation n'est pas livrée.

L'amélioration vérifiée est la suppression ciblée d'alertes répétées dans les cas
testés. Davantage d'utilisations ne garantit pas une amélioration générale ni une
baisse de fraude. Un déploiement réel demanderait une évaluation chronologique des
alertes, des corrections explicites et des incidents, avec une authentification
bancaire ; le canal actuel reste celui du prototype synthétique.

## Vérification

`npm run typecheck`, `npm test` et `npm run build`.

Tests dédiés : `behavior-profile.test.ts`, `behavior-learning.test.ts`,
`behavior-learning-persistence.test.ts` et `frontend-behavior-learning.test.ts`.
