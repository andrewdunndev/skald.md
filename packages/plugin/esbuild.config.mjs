import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const isDev = process.argv.includes('--dev');
const outDir = process.env.SKALD_OUT_DIR ?? './dist';

await fs.mkdir(outDir, { recursive: true });

const copyStatic = async () => {
  // manifest.json + versions.json are canonical at the repo root (BRAT and
  // the Obsidian community-plugins directory read them from there at HEAD);
  // styles.css is local to the plugin package. All three ship as release
  // assets in dist. Paths are relative to the build cwd (packages/plugin).
  const copies = [
    ['../../manifest.json', 'manifest.json'],
    ['../../versions.json', 'versions.json'],
    ['styles.css', 'styles.css'],
  ];
  for (const [src, name] of copies) {
    try {
      await fs.copyFile(src, path.join(outDir, name));
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
