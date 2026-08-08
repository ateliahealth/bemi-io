// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import { Migration } from '@mikro-orm/migrations'

export class Migration20241205185755 extends Migration {
  async up(): Promise<void> {
    // add a column of hash which is nullable
    this.addSql('alter table "changes" add column "hash" varchar(255) null;')
  }

  async down(): Promise<void> {
    this.addSql('alter table "changes" drop column "hash";')
  }
}
