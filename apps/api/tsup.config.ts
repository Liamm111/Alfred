import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: false,
  // Workspace packages are TS source: bundle them. Third-party deps stay external.
  noExternal: [/^@alfred\//],
});
