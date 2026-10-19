// Runs the analytics job's pytest suite with the project venv (jobs/analytics/.venv).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('jobs/analytics');
const py = [path.join(dir, '.venv/Scripts/python.exe'), path.join(dir, '.venv/bin/python')].find((p) => fs.existsSync(p));
if (!py) {
  console.error('analytics venv missing: python -m venv jobs/analytics/.venv && pip install -r jobs/analytics/requirements-dev.txt');
  process.exit(2);
}
const args = ['-m', 'pytest', '-q', ...process.argv.slice(2)];
const r = spawnSync(py, args, { cwd: dir, stdio: 'inherit' });
process.exit(r.status ?? 1);
