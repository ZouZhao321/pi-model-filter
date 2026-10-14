import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const entries = (manifest.pi?.extensions ?? []).map((path) => path.replace(/^\.\//, ''));
const required = [
  'package.json',
  'README.md',
  'README.zh.md',
  'LICENSE',
  'CHANGELOG.md',
  ...entries,
];
const forbidden = [
  /(^|\/)(node_modules|\.github|\.husky|tmp|\.worktrees)\//,
  /(^|\/)docs\/adr\//,
  /(^|\/)(CONTEXT|HANDOFF|SPEC)\.md$/,
];

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', shell: true });
const files = JSON.parse(raw)[0].files.map((entry) => entry.path);
const missing = required.filter((path) => !files.includes(path));
const leaked = files.filter((path) => forbidden.some((pattern) => pattern.test(path)));

console.log(`tarball 文件 ${files.length} 个：`);
for (const path of files) console.log(`  ${path}`);

if (missing.length > 0) {
  console.error(`缺少必须打包的文件：${missing.join(', ')}`);
}
if (leaked.length > 0) {
  console.error(`打包里出现了不该发布的文件：${leaked.join(', ')}`);
}
if (missing.length > 0 || leaked.length > 0) {
  process.exit(1);
}
