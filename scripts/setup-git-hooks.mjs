import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hook = join(root, '.githooks', 'pre-push');

if (!existsSync(join(root, '.git'))) {
  console.log('Git metadata not found; skipping hook setup.');
  process.exit(0);
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: root,
  stdio: 'inherit'
});
chmodSync(hook, 0o755);
console.log('Git pre-push hook enabled: npm run preflight');
