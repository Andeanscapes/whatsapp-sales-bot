import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertDynamicCatalogReady, dynamicDataSchema } from '../../services/dynamic-data-schema.js';

/** Reject corrupt/incompatible remote data before touching local catalog or sync base. */
export function savePulledCatalog(location: string, basePath: string, bytes: Buffer): void {
  assertDynamicCatalogReady(dynamicDataSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown));
  mkdirSync(path.dirname(location), { recursive: true });
  mkdirSync(path.dirname(basePath), { recursive: true });
  writeFileSync(location, bytes);
  writeFileSync(basePath, bytes);
}
