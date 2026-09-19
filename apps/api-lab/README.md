# Laboratoire API Viseca

CLI Node 24 indépendant du wallet et sans dépendance. Depuis la racine de la copie de travail, renseigner `TEAM_API_KEY` dans `.env.local`, puis :

```sh
node apps/api-lab/cli.mjs config
node apps/api-lab/cli.mjs health
node apps/api-lab/cli.mjs reads
node apps/api-lab/cli.mjs draft
```

`config` affiche seulement la présence du token. Les variables exportées dans le terminal prennent priorité sur `.env.local`. `health` ne transmet jamais de bearer. `reads` exécute les cinq GET non consommateurs documentés : bootstrap, références, historique CSV, autorisations et événements. La lecture d’un mandat ou d’un run demande son identifiant réel :

```sh
node apps/api-lab/cli.mjs get /v1/mandates/MANDATE_ID
node apps/api-lab/cli.mjs get /v1/scenario-runs/RUN_ID
node apps/api-lab/cli.mjs get '/v1/events?since=CURSOR'
node apps/api-lab/cli.mjs routes
node apps/api-lab/cli.mjs --help
```

`draft` envoie uniquement `payloads/scen0000-draft.json` et s’arrête. Le fichier contient l’instruction originale exacte et tous les champs du brouillon. Sa règle structurée couvre le prix seulement ; les vérifications de l’unique article alimentaire et de la familiarité du marchand doivent être raccordées au moteur avant de considérer ce brouillon comme une politique complète. `draft --file mon-brouillon.json` permet de proposer sa propre interprétation.

POST et PATCH passent par un fichier contenant un objet JSON explicite. La commande générique permet de préparer chaque étape séparément :

```sh
node apps/api-lab/cli.mjs request POST /v1/mandates --file mon-brouillon.json
node apps/api-lab/cli.mjs request PATCH /v1/mandates/MANDATE_ID --file resserrement.json
node apps/api-lab/cli.mjs request DELETE /v1/mandates/MANDATE_ID
```

La confirmation du mandat exige un fichier `{"confirmed":true}` et l’accord réel du client. Les décisions et résolutions exigent également un fichier explicite ; `/resolve` représente une réponse humaine après `step_up`. Ce CLI ne fait ni confirmation ni décision automatiquement. Un worker opérationnel est nécessaire avant de lancer un scénario : le délai automatique documenté est de 8 secondes à partir de la mise en file, à vérifier dans bootstrap. Le GET `/v1/decision-requests/next?wait=25` consomme une livraison ; il est uniquement disponible par appel explicite et ne figure jamais dans `reads`. Aucun appel ne réinitialise l’équipe.

Chaque appel écrit un rapport JSON sous `.viseca/api-lab/` avec méthode, chemin, statut HTTP, durée et réponse. L’historique produit aussi un CSV. Les fichiers sont en mode `600`, le dossier en `700`, et les secrets sont masqués récursivement, y compris dans les erreurs. Le timeout vaut 30 secondes, configurable avec `--timeout-ms`. Les redirections échouent et aucune mutation n’est automatiquement répétée. Un timeout, un HTTP 5xx ou une réponse de mutation illisible demande une réconciliation par GET avant de répéter l’appel.

Validation locale (utilise des tokens fictifs et deux serveurs HTTP sur boucle locale) :

```sh
node --test apps/api-lab/*.test.mjs
```
