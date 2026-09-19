# Copie parallèle et premiers essais de l’API Viseca

Date : 19 septembre 2026.

## Démarrage rapide

La copie de travail est dans `.parallel/viseca-api/`. Elle contient les sources
actuelles, y compris les modifications non commitées, et sa propre copie des
dépendances. Ses bases, sorties et secrets sont distincts de ceux de l’application
principale. Elle est exclue de Git ; les outils qui la créent et testent l’API
restent dans les sources du projet.

Coller le token d’équipe uniquement dans `.parallel/viseca-api/.env.local` :

```dotenv
TEAM_API_KEY=
LEASH_BASE_URL=https://saw26api.ashyground-364e1d07.switzerlandnorth.azurecontainerapps.io
PORT=3212
AI_ENABLED=false
```

Le fichier est créé avec les permissions `0600`. Les clés OpenAI du projet
principal ne sont pas copiées. Les variables déjà exportées dans le terminal
prennent priorité sur le fichier ; utiliser un terminal sans ancien token exporté.
Le CLI relit le fichier à chaque commande. Le serveur web le lit au démarrage :
le redémarrer après avoir ajouté le token pour activer ses fonctions live.

Depuis la racine du projet :

```sh
cd .parallel/viseca-api
npm run api:lab -- config
npm run api:lab -- health
npm run api:lab -- reads
npm run api:lab -- draft
```

`reads` effectue les lectures de bootstrap, référentiels, historique CSV,
autorisations et événements. `draft` envoie le fichier d’exemple SCEN0000 et crée
un brouillon distant ; il ne confirme pas le mandat et ne lance pas un run.
Ce brouillon sert à tester le transport : sa règle de prix ne couvre pas à elle
seule toutes les exigences du client. Consulter le guide `apps/api-lab/README.md`
pour les payloads et commandes détaillés.

L’interface de la copie fonctionne sur <http://127.0.0.1:3212>. Pour la relancer :

```sh
npm run build
npm run start:local
```

Pour créer une autre copie depuis le projet principal, sans écraser un labo existant :

```sh
npm run api:sandbox -- viseca-api-2
```

Changer ensuite son `PORT` si la première copie est encore démarrée. Une copie
est un instantané : les évolutions futures du projet principal ne s’y propagent pas.

## Plan d’action

| Étape | Appels / travail | Critère de sortie |
| --- | --- | --- |
| 1. Disponibilité | `GET /healthz` sans clé | HTTP 200 et versions du service consignées. |
| 2. Accès équipe | `GET /v1/bootstrap` | Authentification acceptée ; délais et limites réels lus. |
| 3. Données | `GET /v1/reference-data`, historique CSV, authorizations, events | Réponses exploitables et rapports locaux sans token. |
| 4. Premier POST | `POST /v1/mandates` avec l’instruction exacte SCEN0000 | `draft_id` réellement retourné, contenu vérifié. |
| 5. Parcours complet | Revoir les permissions, confirmer le brouillon, préparer le worker, puis créer le run SCEN0000 | `mandate_id` et `run_id` réels ; worker prêt avant la mise en file. |
| 6. Décisions | Polling → décision → éventuelle réponse humaine → réconciliation | Résultat accepté vérifié via run, authorizations et events. |
| 7. Autres méthodes | Lire, restreindre par PATCH et révoquer un mandat de test dédié | Résultats et limites des snapshots vérifiés, sans modifier les autres essais d’équipe. |
| 8. Robustesse | 204, erreurs HTTP, délai dépassé, réponse POST perdue, reprise | Pas de double soumission automatique ; état incertain explicite. |

Le client live et le moteur existants sont conservés dans la copie. Le CLI du
labo permet d’examiner le transport séparément avant de raccorder les résultats
au parcours web. Les succès du transport ne valident pas les décisions du moteur.

## Points du contrat à respecter

- La file distante est commune à l’équipe : **un seul worker consommateur actif
  par token**. Isoler les dossiers ne crée pas une deuxième équipe distante.
- `GET /v1/decision-requests/next` consomme une demande. Il est exclu des lectures
  exploratoires, et s’utilise avec le worker prêt à répondre.
- La deadline de décision par défaut est de 8 secondes depuis la mise en file.
  Lire les valeurs effectives dans bootstrap, et `deadline_at` dans l’événement.
- Une confirmation de mandat ou une réponse `/resolve` représente un accord
  humain. Le test de création de brouillon n’en fabrique pas automatiquement.
- Après une réponse POST perdue, examiner l’état distant avant toute nouvelle
  soumission : aucune garantie d’idempotence distante n’est documentée.
- Aucun reset de l’équipe dans ce plan. `POST /v1/team/reset` efface l’état partagé.
- Le PATCH de permissions conserve les règles précédentes et ne peut que les
  restreindre ; les runs existants gardent leur snapshot.

## État de validation

- GET réel `/healthz` : **HTTP 200**, service `saw26-sandbox`, API `0.1.0`, pack `saw26`.
- Copie compilée et démarrée sur le port 3212 : `/` et `/api/health` renvoient 200.
  Le pack local contient 5 scénarios et 45 achats ; 18 empreintes vérifiées.
- Appels authentifiés et POST distants : **en attente du team token**.
- Tests du CLI : **19/19 réussis**, dont GET et POST via un serveur HTTP local,
  masquage des secrets, absence de retry, CSV, 204 et rejet des redirections.
  Relancer avec `npm run api:test` (les tests HTTP nécessitent l’écoute locale).
- Typecheck et build de la copie réussis. Isolation vérifiée pour 254 liens de
  dépendances et 37 scripts exécutables recopiés.

Source du contrat : [technical_details.md](../technical_details.md), notamment
les sections « Connect to the API » et « All API calls in one place ».
