// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import { PrimaryKey, Property } from '@mikro-orm/decorators/legacy'

export abstract class BaseEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'uuid_generate_v4()' })
  id!: string

  @Property()
  createdAt: Date = new Date()
}
