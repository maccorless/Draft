// Root-level ESLint config for monorepo. Each package (server/, web/, shared-types/)
// has its own eslint.config.mjs. This root config satisfies ESLint v9's config
// discovery when run from the repo root, and ignores all subpackages so their
// own configs govern.
export default [
  {
    ignores: [
      "server/**",
      "web/**",
      "shared-types/**",
      "node_modules/**",
      ".aah/**",
    ],
  },
];
