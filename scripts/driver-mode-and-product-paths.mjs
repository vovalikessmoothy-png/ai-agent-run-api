import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function agentRunnerDir() {
  return resolve(process.env.AGENT_RUNNER_DIR ?? './product');
}

export function resolveRunTarget() {
  const url = String(process.env.RUNNER_API_URL ?? '').trim();
  const key = String(process.env.RUNNER_API_KEY ?? '').trim();
  if (url && key) return { mode: 'remote', base: url.replace(/\/+$/, ''), key };
  if (url || key) {
    console.error('[mode] задан только один из RUNNER_API_URL / RUNNER_API_KEY — режим LOCAL');
  }
  return { mode: 'local' };
}

export const REMOTE_SKIP_REASONS = {
  recovery: 'фаза убивает/рестартует процесс своего сервера — только LOCAL-режим с эфемерным сервером',
  memory: 'замер OOM ведётся по своему процессу на хосте джобы — только LOCAL-режим',
  reboot: 'systemctl reboot затрагивает хост джобы — только LOCAL-режим',
};

export function productCheckout(productDir) {
  const ok = existsSync(join(productDir, 'package.json')) && existsSync(join(productDir, 'src'));
  return { dir: productDir, ok, detail: ok ? 'ok' : `MISSING: нужен чекаут продукта в ${productDir}` };
}

export function resolveBuild(productDir, repoRoot, fallbackTsconfig) {
  const productTsconfig = join(productDir, 'scripts', 'e2e-loop', 'tsconfig.build.json');
  if (existsSync(productTsconfig)) {
    return { tsconfig: productTsconfig, dist: join(productDir, '.e2e-dist'), origin: 'product' };
  }
  if (existsSync(fallbackTsconfig)) {
    return { tsconfig: fallbackTsconfig, dist: join(repoRoot, '.e2e-dist'), origin: 'jobs-repo' };
  }
  return null;
}
