// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import { Options, PostgreSqlDriver } from '@mikro-orm/postgresql'
import { Migrator } from '@mikro-orm/migrations'
import { SqlHighlighter } from '@mikro-orm/sql-highlighter'

import { BaseEntity, Change, MIGRATIONS_PATH } from '@bemi-db/core'

const DB_HOST = process.env.DESTINATION_DB_HOST || process.env.DB_HOST
const DB_PORT = parseInt(process.env.DESTINATION_DB_PORT as string, 10) || parseInt(process.env.DB_PORT as string, 10)
const DB_NAME = process.env.DESTINATION_DB_NAME || process.env.DB_NAME
const DB_USER = process.env.DESTINATION_DB_USER || process.env.DB_USER
const DB_PASSWORD = process.env.DESTINATION_DB_PASSWORD || process.env.DB_PASSWORD

const mikroOrmConfig: Options = {
  driver: PostgreSqlDriver,
  host: DB_HOST,
  port: DB_PORT,
  dbName: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  highlighter: new SqlHighlighter(),
  // Query logging includes bound parameters, i.e. the full row payload (PHI)
  // on every insert into `changes`, which then lands in Cloud Logging.
  debug: process.env.MIKRO_ORM_DEBUG === 'true',
  allowGlobalContext: true,
  // Entity classes rather than a glob over the emitted tree. The glob resolved
  // against whatever layout tsc happened to produce, so a change in rootDir
  // inference yielded an ORM with zero entities at runtime instead of a build
  // error. Importing the classes makes that a compile-time relationship.
  entities: [BaseEntity, Change],
  migrations: {
    // Exported by core, which owns its own build layout.
    path: MIGRATIONS_PATH,
    tableName: '_bemi_migrations',
  },
  extensions: [Migrator],
}

export default mikroOrmConfig
