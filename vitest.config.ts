import { defineConfig } from 'vitest/config';

// Scope the run to this package. The plugin skills under .claude carry their own test files.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
