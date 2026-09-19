#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, READ_PATHS, redact, requestApi, saveReport, validatePath } from './client.mjs';

const help = `API lab Viseca — Node 24, aucune dépendance

node apps/api-lab/cli.mjs <commande>

  config                              Vérifier URL et présence du token, sans l'afficher
  routes                              Inventaire des routes documentées
  health                              GET /healthz, sans Authorization
  reads                               GET bootstrap, références, historique, autorisations, événements
  get /v1/...                         Un GET explicite (y compris mandat ou progression)
  draft [--file payload.json]          POST un brouillon, puis arrêter (aucune confirmation)
  request GET|POST|PATCH|DELETE /v1/... [--file payload.json] [--timeout-ms 30000]
  --help                              Cette aide

Les POST et PATCH exigent --file, sauf draft qui propose l'exemple SCEN0000.
Les fichiers doivent contenir un objet JSON. DELETE n'exige aucun corps.
Le GET /v1/decision-requests/next?wait=25 consomme une livraison : jamais lancé par reads.
Le reset d'équipe est exclu. Aucune mutation n'est relancée automatiquement.
Les secrets viennent de .env.local du dossier courant, ou de l'environnement (prioritaire).
Chaque appel est enregistré sous .viseca/api-lab/ (JSON, plus CSV pour l'historique).
L'exemple de brouillon couvre seulement le prix : revoir ses questions avant confirmation.
`;

const routes = [
  ['GET', '/healthz', 'Disponibilité, sans token'],
  ['GET', '/v1/bootstrap', 'Versions, scénarios, timeouts, limites'],
  ['GET', '/v1/reference-data', 'Catalogues et taux de change'],
  ['GET', '/v1/reference-data/authorization-history.csv', 'Historique CSV'],
  ['POST', '/v1/mandates', 'Créer un brouillon'],
  ['POST', '/v1/mandates/{draft_id}/confirm', 'Accord réel du client requis ; JSON explicite'],
  ['GET', '/v1/mandates/{mandate_id}', 'Lire le mandat'],
  ['PATCH', '/v1/mandates/{mandate_id}', 'Préserver ou resserrer les permissions ; JSON explicite'],
  ['DELETE', '/v1/mandates/{mandate_id}', 'Révoquer le mandat'],
  ['POST', '/v1/scenario-runs', 'Démarrer un scénario ; worker prêt avant appel'],
  ['GET', '/v1/scenario-runs/{run_id}', 'Progression et compteurs'],
  ['GET', '/v1/decision-requests/next?wait=25', 'CONSOMME une livraison, délai décision typique 8 s'],
  ['POST', '/v1/authorizations/{authorization_id}/decision', 'Décision explicite via JSON'],
  ['POST', '/v1/authorizations/{authorization_id}/resolve', 'Réponse réelle du client après step_up ; JSON explicite'],
  ['GET', '/v1/authorizations', 'Autorisations en attente et finales'],
  ['GET', '/v1/events?since=0', 'Événements ; utiliser next_cursor pour la suite'],
  ['POST', '/v1/team/reset', 'DESTRUCTIF ; bloqué dans ce laboratoire'],
];

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    if (!['--file', '--timeout-ms'].includes(name) || !values[index + 1] || options[name] !== undefined) {
      throw new Error('Options acceptées : --file chemin.json et --timeout-ms 30000 (une fois chacune).');
    }
    options[name] = values[index + 1];
  }
  return options;
}

async function readPayload(path) {
  let value;
  try { value = JSON.parse(await readFile(resolve(path), 'utf8')); }
  catch { throw new Error('Impossible de lire le fichier JSON ; vérifiez son chemin et sa syntaxe.'); }
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('Le fichier doit contenir un objet JSON.');
  return value;
}

function validateMutation(method, path, body) {
  if (['POST', 'PATCH'].includes(method) && body === undefined) throw new Error('POST et PATCH exigent --file avec un objet JSON explicite.');
  if (/^\/v1\/mandates\/[^/]+\/confirm$/.test(path.split('?')[0]) && (method !== 'POST' || body?.confirmed !== true)) {
    throw new Error('La confirmation requiert POST et un fichier contenant {"confirmed":true}, après accord réel du client.');
  }
  if (method === 'POST' && /^\/v1\/authorizations\/[^/]+\/(decision|resolve)$/.test(path.split('?')[0])) {
    const resolveAction = path.split('?')[0].endsWith('/resolve');
    const allowed = resolveAction ? ['approve', 'decline'] : ['approve', 'decline', 'step_up'];
    if (!allowed.includes(body?.decision)) throw new Error(`Le fichier doit contenir decision parmi : ${allowed.join(', ')}.`);
    if (!resolveAction && body.authorization_id !== path.split('/')[3]) throw new Error('authorization_id dans le fichier doit correspondre à l’identifiant live du chemin.');
  }
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? '--help';
  if (['--help', '-h', 'help'].includes(command)) { console.log(help); return; }
  if (command === 'routes') {
    if (args.length > 1) throw new Error('routes ne prend pas d’argument.');
    console.log(routes.map(([method, path, description]) => `${method.padEnd(6)} ${path.padEnd(53)} ${description}`).join('\n'));
    return;
  }
  const config = loadConfig();
  if (command === 'config') {
    if (args.length > 1) throw new Error('config ne prend pas d’argument.');
    console.log(JSON.stringify({ base_url: config.baseUrl, team_token: config.apiKey && !/^<.*>$/.test(config.apiKey.trim()) ? 'présent (masqué)' : 'manquant', env_file: resolve(config.cwd, '.env.local'), reports: resolve(config.cwd, '.viseca/api-lab') }, null, 2));
    return;
  }
  if (config.mode === 'disabled') throw new Error('API distante désactivée. Utilisez npm run api:local -- reads avec le simulateur local démarré.');
  let method = 'GET';
  let paths;
  let options;
  if (command === 'health' || command === 'reads') {
    paths = command === 'health' ? ['/healthz'] : READ_PATHS;
    options = parseOptions(args.slice(1));
  } else if (command === 'get') {
    paths = [args[1]];
    options = parseOptions(args.slice(2));
  } else if (command === 'draft') {
    method = 'POST';
    paths = ['/v1/mandates'];
    options = parseOptions(args.slice(1));
    options['--file'] ??= fileURLToPath(new URL('./payloads/scen0000-draft.json', import.meta.url));
  } else if (command === 'request') {
    method = args[1]?.toUpperCase();
    paths = [args[2]];
    options = parseOptions(args.slice(3));
  } else {
    throw new Error('Commande inconnue. Utilisez --help.');
  }
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new Error('Méthode acceptée : GET, POST, PATCH ou DELETE.');
  if (method === 'GET' && options['--file']) throw new Error('GET ne prend pas de fichier JSON.');
  const timeoutMs = options['--timeout-ms'] === undefined ? 30_000 : Number(options['--timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Le timeout doit être compris entre 1 et 120000 ms.');
  const body = options['--file'] ? await readPayload(options['--file']) : undefined;
  for (const path of paths) {
    validatePath(path, { allowHealth: command === 'health' });
    validateMutation(method, path, body);
  }
  for (const path of paths) {
    if (path.split('?')[0] === '/v1/decision-requests/next') console.log('Appel explicite : ce GET consomme une livraison. Le délai de décision continue à courir.');
    const report = await requestApi({ ...config, method, path, body, timeoutMs });
    const files = await saveReport(report, { cwd: config.cwd, secrets: [config.apiKey] });
    console.log(redact(`${method} ${path} → ${report.status ?? report.error.type} · ${report.duration_ms} ms · ${report.ok ? 'OK' : 'ÉCHEC'}`, [config.apiKey]));
    for (const file of files) console.log(`Rapport : ${file}`);
    if (report.response?.format === 'json') {
      const preview = JSON.stringify(report.response.data, null, 2);
      console.log(preview.length > 12_000 ? `${preview.slice(0, 12_000)}\n… voir le rapport complet.` : preview);
    }
    if (report.error) console.error(JSON.stringify(report.error, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
      break;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    let apiKey = process.env.TEAM_API_KEY;
    try { apiKey = loadConfig().apiKey; } catch { /* Config errors never include the raw input. */ }
    console.error(redact(error.message ?? 'Erreur du laboratoire API.', [apiKey]));
    process.exitCode = 1;
  });
}
