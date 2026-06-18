// Bundles browser-only dependencies into self-contained ESM files served from
// /vendor/. Replaces flaky CDN imports (esm.sh / jsdelivr) so the email-OTP
// login flow works even when extensions, proxies, or the CDN itself blocks
// deep transitive imports.
//
// Run: node scripts/bundle-vendor.mjs
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'vendor');
await mkdir(outDir, { recursive: true });

// Empty shim for Node-only modules that get conditionally required by libs
// (cosmjs probes `require('crypto')` and falls back to globalThis.crypto.subtle
// on the browser side). Returning {} makes the probe report unavailable.
const shimDir = join(here, '..', 'node_modules', '.vendor-shims');
await mkdir(shimDir, { recursive: true });
const emptyShim = join(shimDir, 'empty.js');
await writeFile(emptyShim, 'module.exports = {};\n');

const targets = [
  {
    name: 'privy-sdk',
    entry: '@privy-io/js-sdk-core',
  },
  {
    name: 'cosmjs-proto-signing',
    entry: '@cosmjs/proto-signing',
  },
];

// Build each target independently. A failure in one (missing dep, esbuild error)
// must not silently abort the rest — report it, keep going, and exit non-zero at
// the end so CI/the operator knows the vendor bundle is incomplete.
const failures = [];
for (const t of targets) {
  const outfile = join(outDir, `${t.name}.mjs`);
  try {
    await build({
      entryPoints: [t.entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2020'],
      minify: true,
      sourcemap: false,
      legalComments: 'none',
      define: {
        'process.env.NODE_ENV': '"production"',
        global: 'globalThis',
      },
      alias: {
        crypto: emptyShim,
        stream: emptyShim,
        buffer: emptyShim,
        path: emptyShim,
        fs: emptyShim,
        os: emptyShim,
      },
      loader: { '.json': 'json' },
      logLevel: 'info',
    });
    console.log('built', outfile);
  } catch (err) {
    console.error(`✗ failed to bundle "${t.name}" (${t.entry}): ${err.message}`);
    failures.push(t.name);
  }
}

if (failures.length) {
  console.error(`\n${failures.length}/${targets.length} vendor bundle(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nAll ${targets.length} vendor bundles built.`);
