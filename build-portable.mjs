import { execSync } from 'child_process';
import { mkdirSync, cpSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, 'release', 'portable');

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: __dirname, ...opts });
}

console.log('=== NATS Explorer Portable Build ===\n');

if (existsSync(distDir)) rmSync(distDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

// Build client
console.log('[1/2] Building client...');
run('pnpm --filter shared build');
run('pnpm --filter client build');

// Build Go server for current platform
console.log('[2/2] Building Go server...');
run('CGO_ENABLED=0 go build -ldflags="-s -w" -o ' + join(distDir, 'nats-explorer') + ' .', {
  cwd: join(__dirname, 'go-server'),
  env: { ...process.env, CGO_ENABLED: '0' },
});

// Copy client dist
cpSync(join(__dirname, 'client', 'dist'), join(distDir, 'public'), { recursive: true });

// Create start scripts for convenience
writeFileSync(join(distDir, 'start.sh'), `#!/bin/bash
cd "$(dirname "$0")"
export PUBLIC_PATH="$(pwd)/public"
export PORT=\${PORT:-3002}
echo "NATS Explorer starting on http://localhost:\$PORT"
./nats-explorer
`, { mode: 0o755 });

writeFileSync(join(distDir, 'start.bat'), `@echo off
cd /d "%~dp0"
set PUBLIC_PATH=%~dp0public
if "%PORT%"=="" set PORT=3002
echo NATS Explorer starting on http://localhost:%PORT%
nats-explorer.exe
`);

console.log('\n=== Portable Build Complete ===');
console.log(`Output: ${distDir}`);
console.log('  nats-explorer   - Server binary');
console.log('  public/         - Web UI files');
console.log('  start.sh        - Linux/Mac launcher');
console.log('  start.bat       - Windows launcher');
