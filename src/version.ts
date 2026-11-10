import { readFileSync } from 'node:fs';

const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!metadata || typeof metadata !== 'object' || !('version' in metadata) ||
    typeof metadata.version !== 'string' || metadata.version.trim() === '') {
  throw new Error('CLI package version is unavailable');
}

export const PACKAGE_VERSION = metadata.version;
