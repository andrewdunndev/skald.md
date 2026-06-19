import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const isDev = process.argv.includes('--dev');
const outDir = process.env.SKALD_OUT_DIR ?? './dist';

await fs.mkdir(outDir, { recursive: true });

const copyStatic = async () => {
  for (const f of ['manifest.json', 'styles.css', 'versions.json']) {
    try {
      await fs.copyFile(f, path.join(outDir, f));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
};

const staticCopyPlugin = {
  name: 'skald-copy-static',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length === 0) {
        await copyStatic();
      }
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  outfile: path.join(outDir, 'main.js'),
  sourcemap: isDev ? 'inline' : false,
  minify: !isDev,
  treeShaking: true,
  logLevel: 'info',
  plugins: [staticCopyPlugin],
});

if (isDev) {
  await ctx.watch();
  console.log(`skald: watching, output → ${outDir}`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log(`skald: built → ${outDir}`);
}
