import { main } from '../apps/api-lab/cli.mjs';
process.env.VISECA_API_MODE = 'mock';
process.env.LEASH_BASE_URL = `http://127.0.0.1:${process.env.API_MOCK_PORT ?? '4313'}`;
process.env.TEAM_API_KEY = 'local-viseca-test';
main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
