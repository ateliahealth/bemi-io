// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import { describe, expect, test } from 'vitest'

import { isEmptyChange, parseIgnoreFields, filterEmptyChanges } from '../capture-filter'
import { Operation } from '../entities/Change'
import { FetchedRecord } from '../fetched-record'
import { CHANGE_ATTRIBUTES } from './fixtures/fetched-records'

const IGNORED = ['updatedAt', 'updated_at']

const change = ({
  operation = Operation.UPDATE,
  before,
  after,
}: {
  operation?: Operation
  before: object
  after: object
}) => ({ ...CHANGE_ATTRIBUTES.CREATE_MESSAGE, operation, before, after }) as any

describe('parseIgnoreFields', () => {
  test('reads a comma separated list, tolerating spacing', () => {
    expect(parseIgnoreFields(' updatedAt , updated_at ')).toStrictEqual(['updatedAt', 'updated_at'])
  })

  test('is empty when unset, so the default captures everything', () => {
    expect(parseIgnoreFields(undefined)).toStrictEqual([])
    expect(parseIgnoreFields('')).toStrictEqual([])
    // A trailing comma must not produce an empty field name, which would match
    // nothing and quietly widen the filter's key set.
    expect(parseIgnoreFields('updatedAt,')).toStrictEqual(['updatedAt'])
  })
})

describe('isEmptyChange', () => {
  test('drops an update that touched only an ignored field', () => {
    const attrs = change({
      before: { id: 1, title: 'a', isExist: false, updatedAt: '2026-08-09T00:00:00Z' },
      after: { id: 1, title: 'a', isExist: false, updatedAt: '2026-08-09T01:00:00Z' },
    })

    expect(isEmptyChange({ changeAttributes: attrs, ignoreFields: IGNORED })).toBe(true)
  })

  test('keeps an update where a real field moved alongside the timestamp', () => {
    const attrs = change({
      before: { id: 1, isExist: true, updatedAt: '2026-08-09T00:00:00Z' },
      after: { id: 1, isExist: false, updatedAt: '2026-08-09T01:00:00Z' },
    })

    expect(isEmptyChange({ changeAttributes: attrs, ignoreFields: IGNORED })).toBe(false)
  })

  test('keeps everything when no fields are configured', () => {
    // The default. A filter that does something before it is asked to is worse
    // than one that does nothing.
    const attrs = change({ before: { id: 1, updatedAt: 'a' }, after: { id: 1, updatedAt: 'b' } })

    expect(isEmptyChange({ changeAttributes: attrs, ignoreFields: [] })).toBe(false)
  })

  test('keeps creates and deletes regardless of their fields', () => {
    // The row coming into or going out of existence is the information, and no
    // field comparison can call that empty. A DELETE has an empty after image,
    // which would otherwise look like nothing but ignored fields changing.
    const created = change({ operation: Operation.CREATE, before: {}, after: { id: 1, updatedAt: 'b' } })
    const deleted = change({ operation: Operation.DELETE, before: { id: 1, updatedAt: 'a' }, after: {} })

    expect(isEmptyChange({ changeAttributes: created, ignoreFields: IGNORED })).toBe(false)
    expect(isEmptyChange({ changeAttributes: deleted, ignoreFields: IGNORED })).toBe(false)
  })

  test('keeps an update with no before image', () => {
    // What an update looks like without REPLICA IDENTITY FULL. There is nothing
    // to compare, so the change may well be substantive and invisible. Dropping
    // it would silently destroy exactly the records we cannot inspect.
    const attrs = change({ before: {}, after: { id: 1, title: 'a', updatedAt: 'b' } })

    expect(isEmptyChange({ changeAttributes: attrs, ignoreFields: IGNORED })).toBe(false)
  })

  test('keeps an update where a field appears or disappears', () => {
    // A key present on one side only differs from absent, and a schema change
    // is not nothing.
    const added = change({ before: { id: 1 }, after: { id: 1, title: 'new' } })
    const removed = change({ before: { id: 1, title: 'old' }, after: { id: 1 } })

    expect(isEmptyChange({ changeAttributes: added, ignoreFields: IGNORED })).toBe(false)
    expect(isEmptyChange({ changeAttributes: removed, ignoreFields: IGNORED })).toBe(false)
  })

  test('compares nested values rather than identity', () => {
    const same = change({
      before: { id: 1, meta: { a: [1, 2] }, updatedAt: 'x' },
      after: { id: 1, meta: { a: [1, 2] }, updatedAt: 'y' },
    })
    const different = change({
      before: { id: 1, meta: { a: [1, 2] }, updatedAt: 'x' },
      after: { id: 1, meta: { a: [1, 3] }, updatedAt: 'y' },
    })

    expect(isEmptyChange({ changeAttributes: same, ignoreFields: IGNORED })).toBe(true)
    expect(isEmptyChange({ changeAttributes: different, ignoreFields: IGNORED })).toBe(false)
  })

  test('distinguishes null from absent', () => {
    // Clearing a column is a real change, and JSON.stringify(null) differs from
    // JSON.stringify(undefined), which is what makes this work.
    const attrs = change({ before: { id: 1, note: 'x' }, after: { id: 1, note: null } })

    expect(isEmptyChange({ changeAttributes: attrs, ignoreFields: IGNORED })).toBe(false)
  })
})

describe('filterEmptyChanges', () => {
  const record = (streamSequence: number, before: object, after: object) =>
    new FetchedRecord({
      subject: 'bemi-subject',
      streamSequence,
      changeAttributes: change({ before, after }),
    })

  test('reports what it dropped rather than filtering silently', () => {
    const kept = record(1, { id: 1, title: 'a' }, { id: 1, title: 'b' })
    const dropped = record(2, { id: 2, title: 'a', updatedAt: 'x' }, { id: 2, title: 'a', updatedAt: 'y' })

    const result = filterEmptyChanges({ fetchedRecords: [kept, dropped], ignoreFields: IGNORED })

    expect(result.keptFetchedRecords).toStrictEqual([kept])
    // The count is the only evidence the filter is running at all.
    expect(result.skippedCount).toEqual(1)
  })

  test('is a no-op when nothing is configured', () => {
    const records = [record(1, { id: 1, updatedAt: 'x' }, { id: 1, updatedAt: 'y' })]

    const result = filterEmptyChanges({ fetchedRecords: records, ignoreFields: [] })

    expect(result.keptFetchedRecords).toStrictEqual(records)
    expect(result.skippedCount).toEqual(0)
  })
})
