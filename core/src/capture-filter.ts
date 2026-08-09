// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import type { RequiredEntityData } from '@mikro-orm/postgresql'

import { Change, Operation } from './entities/Change'
import { FetchedRecord } from './fetched-record'

// Field-level capture filtering.
//
// Table-level and column-level exclusion happen upstream in Debezium
// (`table.exclude.list`, `column.exclude.list`), because a change that is never
// emitted costs nothing downstream. This handles the case those cannot express:
// keep the column, but do not record a change that touched *only* it.
//
// The motivating shape is a timestamp. An ORM bumps `updatedAt` on every write,
// so a rewrite of unchanged data still produces a change record carrying a
// complete before-image and after-image describing nothing. Excluding the
// column instead would lose the timestamp on changes worth keeping; this keeps
// the column and drops only the empty records.

export const parseIgnoreFields = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field.length > 0)

const valuesDiffer = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)

// True when this record carries no information beyond the ignored fields, and
// can be dropped without losing anything.
//
// Every branch here defaults to keeping the record. A false positive silently
// destroys audit data and is invisible afterwards; a false negative stores a
// row nobody wanted. Those costs are not comparable.
export const isEmptyChange = ({
  changeAttributes,
  ignoreFields,
}: {
  changeAttributes: RequiredEntityData<Change>
  ignoreFields: string[]
}): boolean => {
  if (!ignoreFields.length) return false

  // Only updates. A create or a delete is the existence of the row changing,
  // which no field-level comparison can describe as empty.
  if (changeAttributes.operation !== Operation.UPDATE) return false

  const before = (changeAttributes.before ?? {}) as Record<string, unknown>
  const after = (changeAttributes.after ?? {}) as Record<string, unknown>

  // No before-image, so there is nothing to compare against. This is what an
  // update looks like when the table is not REPLICA IDENTITY FULL - the change
  // may well be substantive and we simply cannot see it. Keep it.
  if (!Object.keys(before).length) return false

  const fields = new Set([...Object.keys(before), ...Object.keys(after)])
  ignoreFields.forEach((field) => fields.delete(field))

  // Every remaining field must be unchanged. A key present in one image and
  // absent from the other differs, since `undefined` stringifies differently
  // from any real value.
  for (const field of fields) {
    if (valuesDiffer(before[field], after[field])) return false
  }

  return true
}

// Returns the records worth persisting plus a count of what was dropped, rather
// than filtering silently. The count is the only evidence this is running at
// all, and a filter that quietly removes audit data with no signal is the thing
// most worth avoiding here.
export const filterEmptyChanges = ({
  fetchedRecords,
  ignoreFields,
}: {
  fetchedRecords: FetchedRecord[]
  ignoreFields: string[]
}): { keptFetchedRecords: FetchedRecord[]; skippedCount: number } => {
  if (!ignoreFields.length) return { keptFetchedRecords: fetchedRecords, skippedCount: 0 }

  const keptFetchedRecords = fetchedRecords.filter(
    (fetchedRecord) => !isEmptyChange({ changeAttributes: fetchedRecord.changeAttributes, ignoreFields }),
  )

  return { keptFetchedRecords, skippedCount: fetchedRecords.length - keptFetchedRecords.length }
}
