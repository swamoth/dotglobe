// Bundle the package. One file for the core, one for the React hook.
import { build } from 'esbuild';
import { existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const entries = [['src/index.ts', 'dist/dotglobe.js'], ['src/react.ts', 'dist/react.js']];

/**
 * Keep the core out of the React bundle. Without this the React entry inlines every core module,
 * and an app that imports both ships the engine two times.
 */
const useCoreBundle = {
  name: 'use-core-bundle',
  setup(build) {
    build.onResolve({ filter: /^\.\/[a-z]+$/ }, (args) => (
      args.kind === 'entry-point' ? null : { path: './dotglobe.js', external: true }
    ));
  },
};

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
      plugins: entry === 'src/react.ts' ? [useCoreBundle] : [],
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
