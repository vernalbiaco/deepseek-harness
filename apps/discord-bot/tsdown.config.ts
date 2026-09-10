import { defineConfig } from 'tsdown'

/**
 * The bot ships one entry, the `bin` in package.json. The root tsdown builds
 * `lib/types/index.js` only, so this override points at `lib/types/bin.js`;
 * declarations come from `tsc -b` (dts: false), matching apps/cli.
 */
export default defineConfig({
  entry: ['lib/types/bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
