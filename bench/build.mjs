// Bundle the package. One file for the core, one for the React hook.
import { build } from 'esbuild';
import { existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const entries = [['src/index.ts', 'dist/dotglobe.js'], ['src/react.tsx', 'dist/react.js']];

export async function bundle({ metafile = false } = {}) {
  rmSync('dist', { recursive: true, force: true });
  const out = {};
  for (const [entry, outfile] of entries) {
    if (!existsSync(entry)) continue;
    out[outfile] = await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      target: 'es2020',
      minify: true,
      legalComments: 'none',
      external: ['react', 'react/jsx-runtime'],
      metafile,
    });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundle();
  execFileSync('npx', ['tsc', '--emitDeclarationOnly', '--declaration', '--outDir', 'dist'], { stdio: 'inherit', shell: true });
  console.log('built dist/');
}
