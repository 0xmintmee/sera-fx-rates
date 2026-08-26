#!/usr/bin/env node
/**
 * Plain Node server, for running this without Cloudflare.
 *
 * Same handler as the Worker, so behaviour cannot drift between the two.
 * Rebuilds the table on an interval and serves the cached copy.
 */

import { createServer } from 'node:http';
import { buildTable } from './rates.js';
import { handle } from './http.js';

const PORT = Number(process.env.PORT || 8787);
const REFRESH_MS = Number(process.env.REFRESH_MS || 60 * 60 * 1000);
const HUB = process.env.HUB || 'USDC';

let table = null;
let building = false;

async function refresh() {
  if (building) return;
  building = true;
  try {
    process.stderr.write('measuring the book...\n');
    table = await buildTable({ hub: HUB, asOf: new Date().toISOString() });
    process.stderr.write(`table built: ${table.currenciesPriced} of ${table.currenciesListed} currencies price\n`);
  } catch (err) {
    process.stderr.write(`measurement failed, keeping the previous table: ${err.message}\n`);
  } finally {
    building = false;
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const ageSeconds = table ? Math.round((Date.now() - Date.parse(table.asOf)) / 1000) : null;
  const out = handle({ pathname: url.pathname, query: url.searchParams }, { table, ageSeconds });
  res.writeHead(out.status, out.headers);
  res.end(out.body);
});

const once = process.argv.includes('--once');
await refresh();
if (once) {
  console.log(JSON.stringify(table, null, 2));
  process.exit(0);
}
setInterval(refresh, REFRESH_MS);
server.listen(PORT, () => process.stderr.write(`listening on http://localhost:${PORT}\n`));
