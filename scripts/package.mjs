import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const files = [
  '.env.example', '.gitignore', 'LICENSE', 'PRIVACY.md', 'README.md', 'package.json',
  'examples/demo.json', 'public/app.mjs', 'public/index.html', 'public/styles.css', 'scripts/package.mjs',
  'src/catalog.mjs', 'src/errors.mjs', 'src/facts.mjs', 'src/review.mjs', 'src/server.mjs', 'src/taodock.mjs',
  'tests/app.test.mjs',
];
const name = `taodock-shopee-sg-${version}.zip`;
const dist = join(root, 'dist');
const output = join(dist, name);
const scratch = mkdtempSync(join(tmpdir(), 'taodock-shopee-sg-package-'));
const timestamp = new Date('2000-01-01T00:00:00Z');

try {
  for (const file of files.sort()) {
    const staged = join(scratch, file);
    mkdirSync(dirname(staged), { recursive: true });
    copyFileSync(join(root, file), staged);
    chmodSync(staged, 0o644);
    utimesSync(staged, timestamp, timestamp);
  }
  const temporaryZip = join(scratch, name);
  execFileSync('zip', ['-X', '-q', temporaryZip, ...files], {
    cwd: scratch, env: { ...process.env, TZ: 'UTC' },
  });
  const archive = readFileSync(temporaryZip);
  const digest = createHash('sha256').update(archive).digest('hex');
  mkdirSync(dist, { recursive: true });
  writeFileSync(output, archive);
  writeFileSync(join(dist, 'SHA256SUMS'), `${digest}  ${name}\n`);
  console.log(`dist/${name}`);
} finally {
  rmSync(scratch, { recursive: true });
}
