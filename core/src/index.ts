// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
// Loaded before the entity modules below: emitDecoratorMetadata emits
// Reflect.metadata() calls, and v7 dropped reflect-metadata as a dependency,
// so without this the ORM reads no design:type and refuses to infer any
// property type.
import 'reflect-metadata'

export { connectJetstream, ensureDebeziumStream, buildConsumer, decodeData, encodeData } from './nats'
export { runIngestionLoop } from './ingestion'
export { parseIgnoreFields, filterEmptyChanges, isEmptyChange } from './capture-filter'
export {
  readReplicationSlots,
  observeSlots,
  logSlotWarnings,
  SLOT_WARNING_MARKER,
  type ReplicationSlotState,
  type SlotWarning,
  type SlotMonitorState,
} from './replication-slot'
export { logger } from './logger'
export { BaseEntity } from './entities/BaseEntity'
export { Change, Operation } from './entities/Change'

// MikroORM's Migrator takes a directory, not a module, so the path has to be
// resolved rather than imported. Exporting it from here keeps the consumer
// from reconstructing core's build layout, which is what previously coupled
// worker/mikro-orm.config.ts to the emitted directory structure.
export const MIGRATIONS_PATH = `${__dirname}/migrations`
