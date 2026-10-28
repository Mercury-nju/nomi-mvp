import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const windows = process.platform === 'win32';
const python = resolve('.venv', windows ? 'Scripts/python.exe' : 'bin/python');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error('安装失败，请检查 Python 3.11+ 和网络连接。');
    process.exit(result.status || 1);
  }
}
if (!existsSync(python)) {
  const options = process.env.NOMI_BOOTSTRAP_PYTHON
    ? [[process.env.NOMI_BOOTSTRAP_PYTHON, []]]
    : windows ? [['py', ['-3.11']], ['python', []]] : [['python3', []]];
  const selected = options.find(([command, args]) => spawnSync(command, [...args, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)'], { windowsHide: true }).status === 0);
  if (!selected) { console.error('需要 Python 3.11+；也可通过 NOMI_BOOTSTRAP_PYTHON 指定其完整路径。'); process.exit(1); }
  run(selected[0], [...selected[1], '-m', 'venv', '.venv']);
}
run(python, ['-c', 'import sys; assert sys.version_info >= (3,11), "需要 Python 3.11+，请重新创建 .venv"']);
run(python, ['-m', 'pip', 'install', '-r', existsSync('requirements.lock.txt') ? 'requirements.lock.txt' : 'requirements.txt']);
if (process.argv.includes('--chromium')) run(python, ['-m', 'playwright', 'install', 'chromium']);
console.log('执行服务已安装。Windows 默认使用 Edge；其他系统可运行 npm run setup -- --chromium。');
