import {defineConfig} from 'vitest/config';

// Workspace's native node:test fixtures run separately with `node --test`.
// Keep their runner distinct while retaining every CLI Vitest suite.
export default defineConfig({test:{include:['tests/**/*.test.ts']}});
