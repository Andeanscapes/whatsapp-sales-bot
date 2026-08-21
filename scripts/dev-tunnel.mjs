/**
 * Dev quick-tunnel helper.
 *
 * A `cloudflared tunnel --url` quick tunnel mints a NEW random hostname on every
 * start, so each dev session otherwise costs two manual steps: editing
 * PUBLIC_BASE_URL and re-pointing the Meta webhook callback. This script does
 * both automatically.
 *
 * Modes:
 *   node scripts/dev-tunnel.mjs           spawn a fresh tunnel, then sync
 *   node scripts/dev-tunnel.mjs --sync    sync from an ALREADY running tunnel
 *
 * Flags:
 *   --env-file <path>   env file to update (default .env.dev)
 *   --no-meta           skip the Meta webhook re-registration
 *
 * Never prints secrets: the app secret, access token, and verify token are used
 * but never logged.
 */
import { spawn, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';

const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
/**
 * A brand-new quick tunnel prints its hostname before the Cloudflare edge
 * actually routes it, so a fresh spawn needs a longer grace period than a sync
 * against an already-established tunnel.
 */
const HEALTH_TIMEOUT_FRESH_MS = 45_000;
const HEALTH_TIMEOUT_SYNC_MS = 15_000;
const HOSTNAME_WAIT_MS = 60_000;

function parseArgs(argv) {
  const args = { syncOnly: false, envFile: '.env.dev', meta: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sync') args.syncOnly = true;
    else if (arg === '--no-meta') args.meta = false;
    else if (arg === '--env-file') {
      i += 1;
      if (!argv[i]) fail('--env-file requires a path');
      args.envFile = argv[i];
    } else fail(`unknown argument: ${arg}`);
  }
  return args;
}

function fail(message) {
  console.error(`[DEV_TUNNEL] ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[DEV_TUNNEL] ${message}`);
}

/** Minimal dotenv reader: `KEY=value`, ignores comments, trims trailing space. */
function readEnvFile(path) {
  if (!existsSync(path)) fail(`env file not found: ${path}`);
  const env = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/**
 * Rewrites PUBLIC_BASE_URL in place, preserving every other line. Atomic via
 * temp file + rename so an interrupted run cannot truncate the env file.
 */
function writePublicBaseUrl(path, url) {
  const raw = readFileSync(path, 'utf-8');
  const line = `PUBLIC_BASE_URL=${url}`;
  const next = /^PUBLIC_BASE_URL=.*$/m.test(raw)
    ? raw.replace(/^PUBLIC_BASE_URL=.*$/m, line)
    : `${raw.replace(/\n?$/, '\n')}${line}\n`;
  if (next === raw) return false;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, next, { mode: 0o600 });
  renameSync(tmp, path);
  return true;
}

/** Discovers the hostname of an already-running quick tunnel via its metrics port. */
function detectRunningTunnel() {
  let pids = [];
  try {
    pids = execFileSync('pgrep', ['-f', 'cloudflared tunnel'], { encoding: 'utf-8' })
      .split('\n').map(p => p.trim()).filter(Boolean);
  } catch {
    return null;
  }

  for (const pid of pids) {
    let ports = [];
    try {
      const out = execFileSync('lsof', ['-Pan', '-p', pid, '-i', '-sTCP:LISTEN'], { encoding: 'utf-8' });
      ports = out.split('\n').slice(1)
        .map(l => l.split(/\s+/)[8])
        .filter(Boolean)
        .map(addr => addr.split(':').pop())
        .filter(Boolean);
    } catch {
      continue;
    }
    for (const port of ports) {
      const host = readHostnameFromMetrics(port);
      if (host) return host;
    }
  }
  return null;
}

function readHostnameFromMetrics(port) {
  try {
    const body = execFileSync('curl', ['-s', '-m', '3', `http://127.0.0.1:${port}/metrics`], { encoding: 'utf-8' });
    const match = /userHostname="(https:\/\/[^"]+\.trycloudflare\.com)"/i.exec(body);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.ok === true) return true;
      }
    } catch {
      // keep polling; the tunnel edge needs a moment after the hostname appears
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Re-points the Meta webhook at the new hostname. Uses an app access token
 * (`app_id|app_secret`); app_id is resolved from debug_token so no extra env
 * var is needed.
 */
async function syncMetaWebhook(env, baseUrl) {
  const version = env.WHATSAPP_GRAPH_API_VERSION || 'v25.0';
  const token = env.WHATSAPP_ACCESS_TOKEN;
  const secret = env.WHATSAPP_APP_SECRET;
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN;
  if (!token || !secret || !verifyToken) {
    log('skipping Meta sync: WHATSAPP_ACCESS_TOKEN / _APP_SECRET / _VERIFY_TOKEN not all set');
    return false;
  }

  const debug = await (await fetch(
    `https://graph.facebook.com/${version}/debug_token?input_token=${encodeURIComponent(token)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )).json();

  if (debug.data?.is_valid !== true) {
    log('WhatsApp access token is NOT valid — refresh it before syncing Meta');
    return false;
  }
  const appId = debug.data.app_id;
  if (!appId) {
    log('could not resolve app_id from debug_token; skipping Meta sync');
    return false;
  }

  const expiresAt = debug.data.expires_at;
  if (expiresAt && expiresAt > 0) {
    const minutes = Math.round((expiresAt * 1000 - Date.now()) / 60000);
    log(minutes > 0
      ? `token expires in ${minutes} min (temporary token — a System User token never expires)`
      : 'token has ALREADY expired — sends will fail with 401');
  }

  const callbackUrl = `${baseUrl}/webhooks/whatsapp`;
  const params = new URLSearchParams({
    object: 'whatsapp_business_account',
    callback_url: callbackUrl,
    verify_token: verifyToken,
    fields: 'messages',
    access_token: `${appId}|${secret}`,
  });

  const res = await fetch(`https://graph.facebook.com/${version}/${appId}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    log(`Meta webhook update FAILED (http ${res.status}): ${body.error?.message ?? 'unknown error'}`);
    log(`set the callback manually: ${callbackUrl}`);
    return false;
  }

  log(`Meta webhook re-pointed to ${callbackUrl}`);
  return true;
}

async function applyHostname(args, env, baseUrl, isFresh) {
  log(`tunnel hostname: ${baseUrl}`);

  // Always record the hostname first: it is correct even when the app is down,
  // and the container needs it in the env file before it boots.
  const changed = writePublicBaseUrl(args.envFile, baseUrl);
  log(changed
    ? `PUBLIC_BASE_URL updated in ${args.envFile}`
    : `PUBLIC_BASE_URL already correct in ${args.envFile}`);

  if (isFresh) log('waiting for the Cloudflare edge to route the new hostname ...');
  const reachable = await waitForHealth(baseUrl, isFresh ? HEALTH_TIMEOUT_FRESH_MS : HEALTH_TIMEOUT_SYNC_MS);
  if (reachable) log('tunnel reaches the app (/health ok)');
  else log(`app NOT reachable through the tunnel yet (is it listening on port ${env.PORT || 3000}?)`);

  if (changed) {
    log('');
    log('IMPORTANT: recreate the container so it reads the new PUBLIC_BASE_URL.');
    log('  compose bakes env vars at create time — "docker restart" is NOT enough:');
    log('  npm run docker:dev');
    log('');
  }

  if (!args.meta) return;

  // Meta fetches the callback during registration and rejects it if the app does
  // not answer the hub.challenge, so syncing while it is down always fails with
  // (#2200). Defer instead of burning a failed attempt.
  if (!reachable) {
    log('SKIPPING Meta webhook sync: Meta must reach the callback to verify it.');
    log('Once the app is up, run:  npm run dev:tunnel:sync');
    return;
  }

  await syncMetaWebhook(env, baseUrl);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envPath = resolve(process.cwd(), args.envFile);
  if (!existsSync(dirname(envPath))) fail(`cannot resolve env file dir: ${envPath}`);
  const env = readEnvFile(envPath);
  const port = env.PORT || '3000';

  if (args.syncOnly) {
    const host = detectRunningTunnel();
    if (!host) fail('no running cloudflared quick tunnel found. Start one, or run without --sync.');
    await applyHostname(args, env, host, false);
    return;
  }

  log(`starting a fresh quick tunnel to http://127.0.0.1:${port} ...`);
  const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.on('error', err => fail(`could not start cloudflared: ${err.message}`));

  let handled = false;
  const timer = setTimeout(() => {
    if (!handled) log('WARNING: no trycloudflare hostname seen yet; still waiting on cloudflared output');
  }, HOSTNAME_WAIT_MS);

  const watch = (stream, sink) => {
    stream.on('data', chunk => {
      const text = chunk.toString();
      sink.write(text);
      if (handled) return;
      const match = QUICK_TUNNEL_RE.exec(text);
      if (!match) return;
      handled = true;
      clearTimeout(timer);
      // Detach from the output handler before awaiting so tunnel logs keep flowing.
      void applyHostname(args, env, match[0], true).catch(err => log(`sync failed: ${err.message}`));
    });
  };
  watch(child.stdout, process.stdout);
  watch(child.stderr, process.stderr);

  const stop = () => { child.kill('SIGINT'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', code => {
    clearTimeout(timer);
    process.exit(code ?? 0);
  });
}

void main();
