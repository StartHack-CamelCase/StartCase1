<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logos/viseca-dark.png">
  <img src="assets/logos/viseca-light.png" alt="Viseca" height="56">
</picture>

<br><br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logos/swiss-ai-weeks-dark.png">
  <img src="assets/logos/swiss-ai-weeks-light.png" alt="Swiss {ai} Weeks" height="34">
</picture>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logos/start-hack-tour-dark.png">
  <img src="assets/logos/start-hack-tour-light.png" alt="START Hack Tour, St. Gallen" height="78">
</picture>

# START Global x Swiss AI Weeks 2026: Viseca Challenge

Materials for Viseca's Swiss {ai} Weeks 2026 hackathon challenge.

</div>

## Contents

| | |
| --- | --- |
| [challenge.md](challenge.md) | Full public challenge brief and judging criteria. |
| [technical_details.md](technical_details.md) | Sandbox API and data contract. |
| [data/](data/) | Synthetic offline data pack: scenarios, purchase attempts, reference data, and JSON schemas. |

## Conception du prototype offline

[Analyse du dépôt, structure de données, routes et plan d'action](docs/README.md).

## Application locale d'inspection

Le dépôt contient une application TypeScript avec serveur et stockage locaux. Elle charge le pack CSV, décode une instruction en JSON complet, puis démarre automatiquement le traitement des achats après confirmation du JSON. Les permissions, décisions et leur provenance sont conservées. Seul le décodage facultatif de l'instruction utilise l'API OpenAI.

Prérequis : Node.js 24 (la version attendue est indiquée dans `.nvmrc`) et pnpm 11.19.0.

```bash
cd '/Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026'
nvm use
pnpm install
pnpm build
pnpm start:local
```

Ouvrir ensuite [http://127.0.0.1:3210](http://127.0.0.1:3210). Le serveur n'écoute que sur l'interface locale. Les brouillons et mandats sont écrits dans `.local-state/`; les runs, événements et traces sont écrits dans `output/`. Ces deux dossiers d'exécution sont ignorés par Git.

Si les dépendances sont déjà installées mais que `pnpm` n’est pas disponible dans le terminal, les scripts se lancent aussi avec `npm run build` puis `npm run start:local`. Le build seul ne démarre pas le serveur ; garder le terminal du serveur ouvert.

Pour lancer le serveur source en mode surveillance (un build initial est effectué automatiquement) :

```bash
pnpm dev:local
```

## Validation et CLI

Pour expérimenter avec l’API hébergée dans une copie indépendante, voir le
[plan de test API parallèle](docs/14_PLAN_TEST_API_PARALLELE.md). `npm run api:sandbox`
copie les sources actuelles dans `.parallel/viseca-api/`, avec un `.env.local`
privé pour `TEAM_API_KEY`, son propre stockage et le port 3212. Le laboratoire
[apps/api-lab](apps/api-lab/README.md) fournit les GET, POST, PATCH et DELETE explicites.

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm offline:validate-data
pnpm offline:inspect --scenario SCEN0000
pnpm offline:inspect-all
```

`offline:inspect-all` parcourt les cinq scénarios et les 45 achats. Tous restent explicitement **Non évalués** : la fin d'un run atteste uniquement que les données ont été parcourues.

## Périmètre actuel

L’inspection historique est conservée. Un mode **simulation locale M/C/G** ajoute les 50 contrôles, une configuration relue et confirmée, les questions humaines typées, les locks et un registre SQLite transactionnel. Le worker **Viseca** est distinct ; il utilise le même moteur et compte uniquement les approbations acceptées par la plateforme. Son parcours hébergé reste à exécuter avec les accès du projet. Voir [le guide d’usage](docs/12_USAGE_SIMULATION_ET_VISECA.md).

## Décoder une instruction

La clé reste côté serveur dans `.env.local`, ignoré par Git. Le serveur charge ce fichier au démarrage ; les variables déjà définies dans l'environnement gardent priorité. Paramètres :

```dotenv
OPENAI_API_KEY=   # renseigner uniquement dans .env.local
OPENAI_MODEL=gpt-5.4-mini
AI_ENABLED=true
```

1. Ouvrir un scénario puis cliquer sur **Decode instruction**.
2. Relire ou modifier le JSON complet dans **Permission JSON**. Aucun formulaire complémentaire n'est demandé. Le serveur valide les types, les bornes et le respect de l'instruction avant d'accepter les paramètres.
3. Cliquer sur **Confirm JSON and start** : le JSON confirmé devient la configuration du moteur et le run démarre automatiquement.

`min_order_chf` et `max_order_chf` s'appliquent au montant total facturé en CHF, frais compris. `null` signifie que cette borne n'a pas été demandée. Un prix exact utilise deux bornes égales :

```json
{
  "min_order_chf": "20",
  "max_order_chf": "20"
}
```

Cet exemple montre seulement les deux champs de montant ; l'interface affiche tous les paramètres exécutables. Une fourchette conserve les deux bornes. Les comparaisons strictes sont converties au centime (`< 20` → maximum `19.99`, `> 20` → minimum `20.01`). Une ambiguïté réelle concernant une proposition d'achat déclenche toujours une revue humaine avant approbation.

Le catalogue des 45 champs est dérivé du schéma officiel `authorization_event.schema.json` : feuilles de `authorization`, politique d'incertitude et plafond de période. Les tailles, couleurs, durées de retour ou critères de familiarité sans champ dédié restent des exigences séparées, pas des champs inventés. Les valeurs extraites décrivent des contraintes, pas des données réelles d'achat (notamment le plafond de période ne représente pas une dépense déjà calculée).

Les métadonnées techniques appartenant exclusivement au pack/runtime (identifiants, ordre source, numéro de ligne, timestamp, compteurs historiques) restent explicitement absentes de cette vue d'instruction. Elles seront fournies par les données locales, jamais inventées par le modèle. Cela ne modifie pas les données d'achat.

Un décodage déclenche **une seule requête Responses**, sans outil ni retry automatique, avec JSON Schema strict et `store: false`. Seules l'instruction exacte et la définition des champs sont envoyées. Le résultat reste une proposition à relire : la validation technique ne garantit pas l'exactitude sémantique. Le fournisseur applique ses politiques de conservation ; `store: false` ne garantit pas une rétention nulle.

Le cache atomique `.local-state/instruction-decodings.json` évite de rappeler le modèle après un double clic, un rechargement ou un redémarrage, pour une instruction/modèle/version de prompt/schéma identiques. Après une erreur ou une interruption, une relance explicite est nécessaire et peut occasionner un nouvel appel facturé. Aucun appel n'est déclenché par la navigation, l'enregistrement d'un mandat ou « Achat suivant ». `AI_ENABLED=false` désactive les nouveaux décodages sans empêcher l'inspection locale ni la lecture des résultats enregistrés. Le serveur est prévu pour une seule instance par dossier de stockage.

Routes du service partagé : `GET /api/scenarios/:scenarioId/instruction-decoding` (lecture locale) et `POST /api/scenarios/:scenarioId/decode-instruction` (en-tête `Idempotency-Key`, corps `{}` ou `{ "retry": true }`). Un brouillon peut référencer `instruction_decoding_id` ; le serveur vérifie son lien avec l'instruction, sans accepter de résultat IA fourni par le navigateur.

L’extraction facultative des faits d’offre utilise également GPT-5 nano, uniquement après un clic explicite. Ses citations sont validées localement et restent des propositions ; le moteur de décision et le worker live n’appellent aucun modèle.

# StartCase1

## Apprentissage des habitudes

L’option **Learn my confirmed habits**, activée explicitement à la confirmation du mandat, permet de reconnaître progressivement les appareils, créneaux horaires et pays confirmés par le client. Les décisions gardent le profil utilisé ; plafonds, exigences produit et confirmations obligatoires restent imposés. Les confirmations ne nourrissent le profil qu’après une approbation finale, et les replays des mêmes achats ne renforcent pas la confiance. Voir [le fonctionnement et les limites](docs/15_APPRENTISSAGE_HABITUDES.md).
