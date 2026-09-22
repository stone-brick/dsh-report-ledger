/**
 * Standalone tsdown config for dsh-report-ledger.
 *
 * Two artifacts, mirroring how the DSH web shell loads a plugin:
 *
 *  - `lib/index.js`  — the HOST half (ESM, node). Loaded by the profile's
 *    cordis Loader from the `report-ledger` row in cordis.patch.yml. The cordis
 *    framework stays external: it resolves at runtime from the dsh profile tree,
 *    never from this repo's install.
 *
 *  - `lib/client.js` — the BROWSER half. The dsh client-modules service serves
 *    it from /plugins/report-ledger/client.js and evaluates it as a
 *    closure-factory artifact: the banner opens `window.__ModuleLoader__.load`
 *    and the injected `require` answers every platform-module specifier from the
 *    shell's frozen module table. That is why the format is `cjs`, why the
 *    platform modules are external, and why everything else is inlined — a
 *    `require()` the table cannot answer is a guaranteed runtime throw.
 *
 * Unlike the dsh-web-ui family preset this config is self-contained: no shared
 * repo root, no CSS-module pipeline (styles are inserted by the client half
 * through its own <style> element, so lightningcss is not on the critical path).
 */
import type { UserConfig } from 'tsdown'

/** Package identity — stamped into the __ModuleLoader__.load handoff. */
const ID = 'dsh-report-ledger'

/**
 * The module specifiers the web shell shares into its frozen module table.
 * Mirrors `@deepseek-ai/dsh-client-web/src/platform`; these MUST stay external.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/**
 * Documented temporary exemption of the family preset: the snapshot-store engine
 * lives in the client runtime pending rehoming, and the lazy CJS table answers
 * this require natively.
 */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals resolved from the loader module table. */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/**
 * Wire/type layers a client bundle may inline: browser-safe contract surfaces
 * with no runtime identity to share. Everything else under `@deepseek-ai/*` is
 * either a module-table entry (external) or a cross-plugin value import, which
 * the purity gate rejects — collaboration goes through cordis services.
 */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/** Host half: ESM for the cordis Loader. */
const host: UserConfig = {
  name: ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  // Off on purpose: a clean pass would race the client config, which emits
  // lib/client.js into the same directory.
  clean: false,
  // Harness packages resolve at runtime from the dsh profile tree and MUST stay
  // external: inlining a service registry would duplicate its classes and break
  // identity. Everything else (the YAML codec) is inlined, because a third-party
  // package cannot rely on the profile's transitive resolution.
  external: ['@deepseek-ai/cordis', /^@deepseek-ai\/dsh-/],
}

/** Browser half: the closure-factory artifact the module loader expects. */
const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  // Browser bundles inline node-idiom deps that read these; vite defined both on
  // the seed path, so a CJS output needs the substitutions or the factory throws.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // tsdown auto-externalizes package dependencies; anything NOT in the loader
  // module table must inline instead.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module, an inline-safe wire layer, `
        + 'or a generated /remote contribution — cross-plugin value imports are forbidden; '
        + 'collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default [host, client]
