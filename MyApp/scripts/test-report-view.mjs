import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

rmSync('allure-results', { recursive: true, force: true });
rmSync('allure-report', { recursive: true, force: true });

const run = spawnSync('npm', ['run', 'test:report'], { stdio: 'inherit' });
const testStatus = run.status ?? 1;
if (run.error) console.error(run.error.message);

if (!existsSync('allure-report/index.html')) {
  console.error('Allure report was not generated. Check the test and report logs.');
  process.exit(testStatus || 1);
}

const view = spawnSync('npm', ['run', 'test:report:open'], { stdio: 'inherit' });
if (view.error) console.error(view.error.message);
process.exit(testStatus || (view.status ?? 1));
