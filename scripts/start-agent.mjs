import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
// Treat configuration as data, never as shell code. Never print credentials.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
const windows = process.platform === 'win32';
const python = process.env.NOMI_PYTHON || resolve('.venv', windows ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) {
  console.error('请先运行 npm run setup，安装本地执行服务。');
  process.exit(1);
}
const dev = process.argv.includes('--dev');
if (!dev && !existsSync('dist/index.html')) {
  console.error('请先运行 npm run build，再启动工作台。');
  process.exit(1);
}
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  process.exitCode = code;
}
function launch(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
  children.push(child);
  child.on('error', error => { console.error(`启动失败：${error.message}`); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 0); });
  return child;
}
launch(python, ['-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', '8765']);
if (dev) launch(process.execPath, ['node_modules/vite/bin/vite.js']);
console.log(`Nomi 工作台：http://127.0.0.1:${dev ? '5173' : '8765'}`);
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
