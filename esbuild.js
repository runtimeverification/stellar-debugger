const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

/** Settings shared by every bundle. */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: !minify,
  minify,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  // `vscode` is provided by the extension host at runtime and must not be bundled.
  external: ['vscode'],
};

/** @type {import('esbuild').BuildOptions} */
const dapServer = {
  ...common,
  entryPoints: ['src/server/main.ts'],
  outfile: 'dist/dap-server.js',
  banner: { js: '#!/usr/bin/env node' },
};

/** @type {import('esbuild').BuildOptions} */
const trace = {
  ...common,
  entryPoints: ['src/trace/main.ts'],
  outfile: 'dist/trace.js',
  banner: { js: '#!/usr/bin/env node' },
};

const allOptions = [extension, dapServer, trace];

async function main() {
  if (watch) {
    const contexts = await Promise.all(allOptions.map((o) => esbuild.context(o)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('esbuild: watching...');
  } else {
    await Promise.all(allOptions.map((o) => esbuild.build(o)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
