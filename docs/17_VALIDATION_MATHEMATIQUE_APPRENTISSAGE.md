# Validation logique et mathématique de l'apprentissage des habitudes

Date : 19 septembre 2026. Implémentation : `behavior-profile-v2`.

## Ce que le calcul établit

Le moteur apprend une **familiarité explicitement confirmée** par le client pour un appareil C15, un créneau C18 ou un pays marchand C19. Il ne calcule ni une probabilité de fraude, ni une probabilité de sécurité. Une faible fréquence d'alertes n'est pas, à elle seule, une preuve de précision.

La décision finale conserve la logique des contrôles : une preuve de familiarité ne compense aucun échec contraignant, une donnée requise absente ni une confirmation explicitement obligatoire. Seuls les trois motifs de revue prévus sont adaptables. Les filtres ont des paramètres distincts ; cette séparation ne suppose pas que leurs risques soient statistiquement indépendants.

## Définition exacte

Pour un client `u`, un environnement `s`, un filtre `i`, un contexte exact `c`, un instant d'achat simulé `t` et un curseur de connaissance `k` :

1. Ne conserver que les observations attribuées à `(u,s)` et disponibles avec `sequence <= k`. Si un curseur est fourni, une observation sans séquence ne prouve pas sa disponibilité et est exclue.
2. Dédupliquer par `(source_id, filter_id)` avant tout oubli. La première séquence reste celle de la source ; la rejouer avec une nouvelle autorisation ne crée pas de preuve. Un conflit de contexte ou d'instant pour la même source provoque le retour aux contrôles ordinaires.
3. Appliquer les contrôles de contexte disponibles à `k` dans l'ordre de leurs séquences. Un oubli ou une réactivation ouvre une génération ; seules les observations strictement postérieures à sa séquence restent admissibles. Les observations anciennes sans séquence ne survivent à aucun contrôle.
4. Exiger `occurred_at < t`. La réception réelle du feedback (`recorded_at`) n'est jamais comparée à l'horloge simulée. Elle reste une information de provenance.
5. Dans cette génération, choisir la première observation par date locale, **avant de tronquer l'historique à la fenêtre temporelle**.
6. Parmi ces représentants, conserver ceux dont l'âge réel en jours de 24 heures est inférieur ou égal à `W_i`.

Pour cet ensemble `D_i`, on calcule :

```text
âge_j = (t - occurred_at_j) / 86 400 000
w_j   = 2^(-âge_j / h_i)
E_i   = somme des w_j, pour j dans D_i
N_i   = nombre de représentants dans D_i
```

Une habitude est utilisable si `N_i >= d_i` ET `E_i >= T_i`, sous réserve du consentement actif, de l'absence de suspension et d'un motif de revue éligible. Valeurs initiales par filtre : `d=3`, `T=2`, `h=30 jours`, `W=90 jours`.

La fenêtre et la demi-vie utilisent des durées absolues de 24 heures. Le plafond d'une contribution par date utilise le calendrier du fuseau du mandat, y compris les changements d'heure. Ces deux unités répondent à des besoins distincts et ne sont pas confondues.

Les paramètres exigent un nombre de dates entier positif et des poids/durées finis strictement positifs. Un seuil très restrictif peut rendre l'apprentissage impossible ; une configuration syntaxiquement valide ne signifie donc pas qu'elle est pertinente. Les valeurs initiales sont des choix de prototype, pas des seuils calibrés sur une population bancaire.

## Propriétés vérifiées

**Borne du poids.** Puisque chaque observation utilisée est strictement antérieure à `t` et que `h_i > 0`, `0 < w_j <= 1` mathématiquement. Donc `0 <= E_i <= N_i`. En arithmétique flottante, une contribution extrêmement ancienne peut s'arrondir à zéro ; cela est conservateur.

**Demi-vie.** En l'absence d'entrée ou de sortie de fenêtre, `E_i(t+Δ) = E_i(t) × 2^(-Δ/h_i)`. Avec `Δ = h_i`, le poids est divisé par deux.

**Absence de croissance spontanée.** Pour des paramètres, une génération et un historique passé fixes, lorsque `t` avance après tous les événements de cet historique, chaque poids décroît et les sorties de fenêtre retirent des termes positifs. `E_i` et `N_i` ne peuvent donc pas augmenter. Cette propriété ne s'applique pas à l'arrivée d'un nouveau feedback, à un changement de paramètres ou à une nouvelle génération.

**Correction d'un défaut de la première version.** Tronquer d'abord la fenêtre puis choisir la première observation quotidienne permettait à une seconde observation du même jour de remplacer la première à son expiration. Le score pouvait alors augmenter sans nouvelle confirmation. La version 2 choisit le représentant sur l'historique complet de la génération avant la fenêtre ; le test balaie heure par heure les sorties de fenêtre et vérifie la décroissance.

**Plafond quotidien.** Une rafale ne produit jamais plus d'une contribution par date locale et contexte. Les confirmations uniques brutes et le nombre de jours contributeurs sont deux compteurs différents. À la frontière de fenêtre, une confirmation tardive du même jour peut encore être visible dans le compteur brut mais ne reprend pas la contribution du représentant expiré.

**Deux seuils nécessaires.** Le nombre de dates évite qu'un poids suffisant provenant de trop peu de jours soit accepté ; le poids évite que trois dates trop anciennes suffisent. Trois dates ne garantissent donc pas systématiquement une habitude utilisable.

**Ordre de connaissance.** Recalculer un profil avec le même `t`, le même `k`, les mêmes paramètres et le même journal donne le même résultat, même si le journal complet contient maintenant des retours ou corrections postérieurs à `k`. La disponibilité n'est pas déduite de l'heure simulée du paiement.

**Versionnement.** Le hash des paramètres est indépendant du hash du profil. Le profil inclut l'algorithme, les paramètres, le fuseau canonique, l'instant simulé, le curseur disponible et les états des contextes. Modifier les paramètres de C18 change leur version, sans changer les preuves ni l'état de C15/C19.

## Oubli, suspension et réactivation

- **Oublier** ouvre une nouvelle génération. Rejouer une source déjà enregistrée n'a aucun effet : la déduplication est effectuée avant la sélection de génération et le journal conserve l'identité de la source.
- **Suspendre** interdit l'utilisation de l'habitude et la collecte de nouvelles confirmations positives pour ce contexte. Les preuves antérieures peuvent rester visibles avec l'état « suspendu ».
- **Oublier un contexte suspendu** ne lève pas sa suspension.
- **Réactiver** lève la suspension et ouvre une nouvelle génération sans restaurer les anciennes preuves. De nouvelles sources explicitement confirmées sont nécessaires.
- Un contrôle reste visible même si toutes les confirmations ont expiré. Le passage du temps ne lève pas une suspension.

La séquence d'un contrôle fait autorité. Son horodatage de réception est conservé pour l'audit ; changer son format de fuseau ou comparer cette date à une date simulée ne modifie pas son ordre logique.

## Pannes et isolation

Les données d'un autre client ou environnement ne doivent pas invalider ce profil. Elles sont écartées avant la validation de leur contenu. Une preuve ciblée incohérente déclenche une reconstruction sans preuves positives, qui conserve les contrôles valides. Si les contrôles eux-mêmes sont illisibles, toute adaptation et toute nouvelle collecte sont désactivées pour cette évaluation. Les contrôles ordinaires restent actifs ; aucun ancien cache appris ne sert de substitution.

Le calcul est pur et ne décide pas de l'authenticité d'un acteur. Les services restent responsables de l'authentification, de l'attribution au client, de la séquence transactionnelle et de l'approbation finale avant apprentissage positif. Une approbation automatique ne devient jamais un label. Une préférence refusée n'est pas présentée comme une fraude bancaire avérée.

## Limites de l'interprétation statistique

L'ensemble des retours est sélectionné par les alertes et les réponses effectivement obtenues. Le taux de confirmations sur cet ensemble n'est pas nécessairement celui de tous les achats. Un achat automatisé sans plainte n'est pas un exemple positif. Les résultats d'un corpus synthétique démontrent des propriétés et des scénarios prévus ; ils n'estiment pas une précision réelle de production.

Pour comparer des paramètres, il faut respecter l'ordre d'arrivée des retours, séparer apprentissage/réglage/test, afficher les dénominateurs et conserver les cas inconnus. Un candidat qui réduit les alertes peut aussi masquer des anomalies : la réduction seule ne justifie pas son activation. Le plan 16 conserve donc une boucle de sélection contrôlée, versionnée et réversible ; aucune optimisation non validée ne peut affaiblir les règles contraignantes.

## Tests exécutables

`tests/behavior-profile.test.ts` couvre la demi-vie, la décroissance aux frontières de fenêtre, les deux seuils, le plafond quotidien, le fuseau, l'indépendance des paramètres, les versions, les deux axes temporels, la déduplication, l'oubli, la suspension, la réactivation et l'isolation des données.

`tests/behavior-learning.test.ts` couvre l'application dans le moteur, l'absence d'auto-renforcement, les plafonds et confirmations obligatoires, la suspension de collecte et le retour sûr aux contrôles ordinaires.

Ces preuves de programme et ces propriétés mathématiques sont distinctes d'une validation antifraude sur des incidents réels.
