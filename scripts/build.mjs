import path from 'node:path';
import { build } from 'esbuild';

const projectRoot = process.cwd();

await build({
  absWorkingDir: projectRoot,
  entryPoints: [path.join(projectRoot, 'src', 'extension.ts')],
  outfile: path.join(projectRoot, 'out', 'extension.js'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  logLevel: 'info',
});
