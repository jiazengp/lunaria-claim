import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * runner 冒烟：模拟 Actions runner 的加载方式——只拿仓库内容（dist/ + main.cjs），
 * 不安装依赖。dist 若把运行时依赖当 external，这里就会复现
 * ERR_MODULE_NOT_FOUND（真实 runner 上的发布阻断 bug），CI 立即失败。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'lunaria-claim-smoke-'));
try {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  copyFileSync(join(root, 'dist/index.mjs'), join(dir, 'dist/index.mjs'));
  copyFileSync(join(root, 'dist/index.mjs.map'), join(dir, 'dist/index.mjs.map'));
  copyFileSync(join(root, 'main.cjs'), join(dir, 'main.cjs'));

  let code = 0;
  let output = '';
  try {
    execFileSync(process.execPath, [join(dir, 'main.cjs')], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const err = error;
    code = err && typeof err === 'object' && 'status' in err ? Number(err.status ?? 1) : 1;
    output = `${err?.stdout ?? ''}${err?.stderr ?? ''}`;
  }

  if (output.includes('ERR_MODULE_NOT_FOUND')) {
    throw new Error(`runner smoke failed: external dependency unresolved\n${output}`);
  }
  if (!output.includes('Input required and not supplied: mode')) {
    throw new Error(
      `runner smoke failed: expected input validation error, got exit=${code}\n${output}`,
    );
  }
  console.log(`runner smoke ok: self-contained under a bare runner (expected exit ${code})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
