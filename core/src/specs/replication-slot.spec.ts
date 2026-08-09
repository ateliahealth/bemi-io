// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import { describe, expect, test } from 'vitest'

import { observeSlots, ReplicationSlotState, SlotMonitorState } from '../replication-slot'

const GB = 1024 * 1024 * 1024
const WARN_BYTES = 10 * GB
const GRACE_MS = 15 * 60 * 1000
const T0 = 1_700_000_000_000

const slot = (overrides: Partial<ReplicationSlotState> = {}): ReplicationSlotState => ({
  slotName: 'bemi_local',
  slotType: 'logical',
  active: true,
  walStatus: 'reserved',
  retainedBytes: 0,
  ...overrides,
})

const observe = ({
  slots,
  previousState = {},
  now = T0,
}: {
  slots: ReplicationSlotState[]
  previousState?: SlotMonitorState
  now?: number
}) => observeSlots({ slots, previousState, now, retentionWarnBytes: WARN_BYTES, inactiveGraceMs: GRACE_MS })

describe('observeSlots', () => {
  test('stays quiet for an active slot below the threshold', () => {
    const { warnings } = observe({ slots: [slot({ retainedBytes: 451 * 1024 * 1024 })] })

    expect(warnings).toStrictEqual([])
  })

  test('does not warn the first time a slot is seen inactive', () => {
    // The case the compose gate caught. Killing the consumer makes its slot
    // inactive for a few seconds, and an alarm that fires on every restart
    // gets muted - which is the state that lets an abandoned slot grow
    // unnoticed. Only sustained inactivity separates abandoned from
    // restarting.
    const { warnings, state } = observe({ slots: [slot({ active: false, retainedBytes: 2048 })] })

    expect(warnings).toStrictEqual([])
    // The clock is started, though, so the next observation can measure it.
    expect(state).toStrictEqual({ bemi_local: T0 })
  })

  test('still says nothing one poll before the grace period elapses', () => {
    const { warnings } = observe({
      slots: [slot({ active: false })],
      previousState: { bemi_local: T0 },
      now: T0 + GRACE_MS - 1,
    })

    expect(warnings).toStrictEqual([])
  })

  test('warns once the slot has stayed inactive past the grace period', () => {
    const { warnings } = observe({
      slots: [slot({ slotName: 'abandoned', active: false, retainedBytes: 1024 })],
      previousState: { abandoned: T0 },
      now: T0 + GRACE_MS,
    })

    expect(warnings.map((w) => w.reason)).toStrictEqual(['inactive'])
    expect(warnings[0].message).toContain('900s')
  })

  test('measures from when the slot went quiet, not from the latest poll', () => {
    // Carrying the timestamp forward is the whole mechanism: reset it each
    // poll and the grace period never elapses, so nothing ever warns.
    const first = observe({ slots: [slot({ active: false })] })
    const second = observe({ slots: [slot({ active: false })], previousState: first.state, now: T0 + 60_000 })
    const third = observe({ slots: [slot({ active: false })], previousState: second.state, now: T0 + GRACE_MS })

    expect(second.warnings).toStrictEqual([])
    expect(third.warnings.map((w) => w.reason)).toStrictEqual(['inactive'])
  })

  test('forgets the timer when a slot comes back', () => {
    const { warnings, state } = observe({
      slots: [slot({ active: true })],
      previousState: { bemi_local: T0 },
      now: T0 + GRACE_MS,
    })

    expect(warnings).toStrictEqual([])
    // Not merely unreported - cleared, so a later restart gets a fresh grace
    // period instead of warning immediately on the strength of an old one.
    expect(state).toStrictEqual({})
  })

  test('forgets slots that no longer exist', () => {
    const { state } = observe({ slots: [], previousState: { dropped: T0 } })

    expect(state).toStrictEqual({})
  })

  test('reports a long-inactive slot once, not also as retention', () => {
    const { warnings } = observe({
      slots: [slot({ active: false, retainedBytes: 800 * GB })],
      previousState: { bemi_local: T0 },
      now: T0 + GRACE_MS,
    })

    expect(warnings.map((w) => w.reason)).toStrictEqual(['inactive'])
  })

  test('warns immediately when an active slot crosses the retention threshold', () => {
    // No grace period on this one: retention is cumulative, so unlike
    // inactivity it will not resolve itself on the next poll.
    const { warnings } = observe({ slots: [slot({ retainedBytes: WARN_BYTES })] })

    expect(warnings.map((w) => w.reason)).toStrictEqual(['retention'])
  })

  test('reports wal_status alongside the size warning, not instead of it', () => {
    // Two independent facts: 'lost' means WAL the slot needs is already gone,
    // which no size threshold expresses.
    const { warnings } = observe({ slots: [slot({ walStatus: 'lost', retainedBytes: 40 * GB })] })

    expect(warnings.map((w) => w.reason)).toStrictEqual(['retention', 'wal_status'])
  })

  test('ignores slots the pipeline does not own', () => {
    // Not a filter - an assertion that there is none. A slot left behind by a
    // previous incarnation pins WAL exactly as hard as the current one, and it
    // is the orphan that goes unnoticed.
    const { warnings } = observe({
      slots: [slot({ slotName: 'some_other_tool', active: false, retainedBytes: 851 * GB })],
      previousState: { some_other_tool: T0 },
      now: T0 + GRACE_MS,
    })

    expect(warnings.map((w) => w.reason)).toStrictEqual(['inactive'])
    expect(warnings[0].message).toContain('851.0 GB')
  })

  test('says nothing when the server reports no slots', () => {
    // What a destination on a separate server looks like. Silence is correct:
    // the alternative is every such deployment alerting permanently.
    expect(observe({ slots: [] }).warnings).toStrictEqual([])
  })
})
