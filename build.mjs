import { execSync } from 'child_process';
import { mkdirSync, cpSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, 'release');

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: __dirname, ...opts });
}

const targets = [
  { goos: 'linux', goarch: 'amd64', name: 'linux-x64', ext: '' },
  { goos: 'linux', goarch: 'arm64', name: 'linux-arm64', ext: '' },
  { goos: 'windows', goarch: 'amd64', name: 'windows-x64', ext: '.exe' },
  { goos: 'darwin', goarch: 'amd64', name: 'macos-x64', ext: '' },
  { goos: 'darwin', goarch: 'arm64', name: 'macos-arm64', ext: '' },
];

// Allow filtering targets via CLI arg
const targetFilter = process.argv[2];

console.log('=== NATS Explorer Build ===\n');

if (existsSync(distDir)) rmSync(distDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

// 1. Build client
console.log('[1/3] Building client...');
run('pnpm --filter shared build');
run('pnpm --filter client build');

// 2. Build Go server for all targets
console.log('\n[2/3] Cross-compiling Go server...');

const selectedTargets = targetFilter
  ? targets.filter(t => t.name.includes(targetFilter))
  : targets;

for (const target of selectedTargets) {
  const outDir = join(distDir, `nats-explorer-${target.name}`);
  mkdirSync(outDir, { recursive: true });

  const binary = join(outDir, `nats-explorer${target.ext}`);
  console.log(`  Building ${target.name}...`);
  run(`CGO_ENABLED=0 GOOS=${target.goos} GOARCH=${target.goarch} go build -ldflags="-s -w" -o ${binary} .`, {
    cwd: join(__dirname, 'go-server'),
    env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
  });

  // Copy client dist
  cpSync(join(__dirname, 'client', 'dist'), join(outDir, 'public'), { recursive: true });
}

// 3. Create archives
console.log('\n[3/3] Creating archives...');
for (const target of selectedTargets) {
  const dirName = `nats-explorer-${target.name}`;
  if (target.name.startsWith('windows')) {
    try {
      run(`cd ${distDir} && zip -r ${dirName}.zip ${dirName}/`);
    } catch {
      console.log(`  Skipping zip for ${target.name} (zip not available)`);
    }
  } else {
    run(`cd ${distDir} && tar czf ${dirName}.tar.gz ${dirName}/`);
  }
}

console.log('\n=== Build Complete ===');
console.log(`\nOutputs in ${distDir}:`);
for (const target of selectedTargets) {
  console.log(`  nats-explorer-${target.name}/`);
  console.log(`    nats-explorer${target.ext}  - ${target.name} binary`);
  console.log(`    public/                     - Web UI files`);
}
console.log('\nUsage: Place binary and public/ folder together, then run:');
console.log('  PUBLIC_PATH=./public ./nats-explorer');
console.log('  Open http://localhost:3002 in your browser');
