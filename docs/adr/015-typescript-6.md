# ADR-015: Stay on TypeScript 6.x until typescript-eslint supports 7

- Status: Accepted (2026-09-20)
- Context: `typescript@latest` resolves to 7.x, the native compiler. `typescript-eslint` 8.70
  supports TypeScript `>=4.8.4 <6.1.0`, so type-aware lint rules (including the security-relevant
  `no-unsafe-*` and `no-floating-promises`) can't run on 7.
- Decision: Pin `typescript@6.0.x` and `@types/node@24.x` (matching the Node 24 runtime) in every
  package. Dependabot major-version PRs for TypeScript are declined until typescript-eslint
  supports 7.
- Consequences: Slower typechecks than TS 7's native compiler. Revisit when typescript-eslint
  ships TS 7 support.
