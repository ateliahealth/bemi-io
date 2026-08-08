// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
export { connectJetstream, ensureDebeziumStream, buildConsumer, decodeData, encodeData } from './nats'
export { runIngestionLoop } from './ingestion'
export { logger } from './logger'
export { BaseEntity } from './entities/BaseEntity'
export { Change, Operation } from './entities/Change'

// MikroORM's Migrator takes a directory, not a module, so the path has to be
// resolved rather than imported. Exporting it from here keeps the consumer
// from reconstructing core's build layout, which is what previously coupled
// worker/mikro-orm.config.ts to the emitted directory structure.
export const MIGRATIONS_PATH = `${__dirname}/migrations`
