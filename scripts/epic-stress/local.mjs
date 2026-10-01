// local.mjs — эфемерный Serverless API для LOCAL-прогонов (паттерн stress-probe.mjs):
// tsc-сборка продукта → .e2e-dist + scripts/e2e-loop/server.mjs как дочерний процесс.
// Отличие от stress-probe: ошибки возвращаются, а не process.exit — кейс получает SKIP с причиной.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentRunnerDir, productCheckout, resolveBuild } from '../driver-mode-and-product-paths.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..', '..');
export const E2E_SERVER = join(REPO_ROOT, 'scripts', 'e2e-loop', 'server.mjs');

export function productPaths() {
  const dir = agentRunnerDir();
  const checkout = productCheckout(dir);
  const buildConfig = resolveBuild(dir, REPO_ROOT, join(SCRIPT_DIR, '..', 'e2e-loop', 'tsconfig.build.json'));
  return { dir, checkout, buildConfig };
}

export function buildDist() {
  const { checkout, buildConfig } = productPaths();
  if (!checkout.ok) return { error: `нет чекаута продукта: ${checkout.detail}` };
  if (!buildConfig) return { error: 'tsconfig.build.json не найден ни в продукте, ни в этой репе' };
  const tsc = join(checkout.dir, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) return { error: `typescript не найден в ${join(checkout.dir, 'node_modules')} — выполните npm ci в продукте` };
  rmSync(buildConfig.dist, { recursive: true, force: true });
  mkdirSync(buildConfig.dist, { recursive: true });
  const build = spawnSync(process.execPath, [tsc, '-p', buildConfig.tsconfig], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (build.status !== 0) return { error: `tsc failed:\n${build.stdout ?? ''}\n${build.stderr ?? ''}` };
  if (!existsSync(join(buildConfig.dist, 'api', 'service.js'))) return { error: `tsc не положил api/service.js в ${buildConfig.dist}` };
  return { dist: buildConfig.dist };
}

/**
 * Старт дочернего API-сервера. opts: { rootDir?, withOpenCode?, port? }.
 * Возвращает { child, port, key, controlToken, rootDir, stop() }.
 */
export async function startServer(options = {}) {
  const built = options.dist ? { dist: options.dist } : buildDist();
  if (built.error) return { error: built.error };

  const rootDir = options.rootDir ?? join(tmpdir(), `epic-stress-${randomBytes(6).toString('hex')}`);
  mkdirSync(rootDir, { recursive: true });
  const controlToken = randomBytes(24).toString('hex');
  const clientKey = `ak_${randomBytes(24).toString('hex')}`;
  const keysPath = join(rootDir, 'e2e-keys.json');
  writeFileSync(
    keysPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        principals: [
          {
            keyHash: createHash('sha256').update(clientKey, 'utf8').digest('hex'),
            principalId: 'epic-stress-client',
            profileId: options.profileId ?? 'profile-epic',
            scopes: ['runs:read', 'runs:write'],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const child = spawn(process.execPath, [E2E_SERVER], {
    env: {
      ...process.env,
      E2E_DIST: built.dist,
      E2E_ROOT_DIR: rootDir,
      E2E_PORT: String(options.port ?? 0),
      E2E_CONTROL_TOKEN: controlToken,
      E2E_KEYS_PATH: keysPath,
      E2E_WITH_OPENCODE: options.withOpenCode ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let port = null;
  let buffer = '';
  let stderrText = '';
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const parsed = JSON.parse(line);
        if (parsed.event === 'e2e_server_listening') port = parsed.port;
      } catch {
        /* не-JSON строка — ок */
      }
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrText += String(chunk);
  });

  const deadline = Date.now() + 30_000;
  while (port === null && Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (port === null) {
    child.kill('SIGKILL');
    return { error: `сервер не поднялся за 30s; stderr=${stderrText.slice(-500)}` };
  }

  const base = `http://127.0.0.1:${port}`;
  return {
    child,
    port,
    base,
    key: clientKey,
    controlToken,
    rootDir,
    dist: built.dist,
    async stop(options = {}) {
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (child.exitCode === null) child.kill('SIGKILL');
      if (options.keepData) return;
      try {
        rmSync(rootDir, { recursive: true, force: true });
      } catch {
        /* уже убрано */
      }
    },
    async kill() {
      if (child.exitCode === null) child.kill('SIGKILL');
      await new Promise((resolve) => child.on('exit', resolve));
    },
  };
}

/** Контроль-клиент дочернего сервера (fault injection и пр.). */
export function control(server) {
  return {
    async call(path, options = {}) {
      const response = await fetch(`${server.base}${path}`, {
        method: options.method ?? 'POST',
        headers: { 'content-type': 'application/json', 'x-e2e-control-token': server.controlToken },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let json = null;
      try {
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, json, text };
    },
    injectFault(point, spec = { kind: 'throw', once: true }) {
      return this.call('/_e2e/fault', { body: { point, ...spec } });
    },
    clearFaults() {
      return this.call('/_e2e/fault/clear', { body: {} });
    },
  };
}

export function readDistFaultPoints() {
  const { buildConfig } = productPaths();
  if (!buildConfig || !existsSync(join(buildConfig.dist, 'faults', 'registry.js'))) return null;
  try {
    const source = readFileSync(join(buildConfig.dist, 'faults', 'registry.js'), 'utf8');
    const match = /FAULT_POINTS\s*=\s*\[([^\]]*)\]/.exec(source);
    if (!match) return null;
    return match[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  } catch {
    return null;
  }
}
