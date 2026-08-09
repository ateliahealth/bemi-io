// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import type { MikroORM } from '@mikro-orm/postgresql'

import { logger } from './logger'

export interface ReplicationSlotState {
  slotName: string
  slotType: string
  active: boolean
  // Postgres 13+. 'reserved' | 'extended' | 'unreserved' | 'lost'; 'lost' means
  // WAL the slot still needs has already been removed and it can never resume.
  walStatus: string | null
  // Measured from restart_lsn, not confirmed_flush_lsn. restart_lsn is the
  // oldest WAL the slot still requires, so it is what actually pins the files;
  // confirmed_flush_lsn runs ahead of it and understates retention.
  retainedBytes: number
}

// Slots are cluster-wide, so this sees every slot on the server the connection
// lands on - including ones no consumer owns. That is the point: a slot nobody
// reads is invisible to the data path by definition, so no amount of pipeline
// instrumentation can find it. It has to be asked for by name from the server.
//
// This works from the destination connection only when the source and
// destination databases share a server. When they do not, the query returns
// the destination's slots (usually none) and reports nothing, which is why an
// empty result is not treated as a problem anywhere below.
const SLOT_QUERY = `
  SELECT
    slot_name,
    slot_type,
    active,
    wal_status,
    pg_wal_lsn_diff(
      CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn() ELSE pg_current_wal_lsn() END,
      restart_lsn
    )::bigint AS retained_bytes
  FROM pg_replication_slots
`

export const readReplicationSlots = async (orm: MikroORM): Promise<ReplicationSlotState[]> => {
  const rows = await orm.em.getConnection().execute(SLOT_QUERY)

  return rows.map((row: any) => ({
    slotName: row.slot_name,
    slotType: row.slot_type,
    active: row.active,
    walStatus: row.wal_status ?? null,
    // bigint arrives as a string from pg, and a slot with a null restart_lsn
    // (never used) yields null rather than 0.
    retainedBytes: row.retained_bytes === null ? 0 : Number(row.retained_bytes),
  }))
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

export interface SlotWarning {
  slotName: string
  reason: 'inactive' | 'retention' | 'wal_status'
  message: string
}

// slot name -> the first observation at which it was seen inactive, kept so a
// slot has to stay inactive rather than merely be caught mid-restart.
export type SlotMonitorState = Record<string, number>

// Deliberately does not consider whether a slot is "ours". An abandoned slot
// left by a previous incarnation of this pipeline retains WAL exactly as hard
// as a foreign one, and it is the abandoned case that goes unnoticed.
export const observeSlots = ({
  slots,
  previousState,
  now,
  retentionWarnBytes,
  inactiveGraceMs,
}: {
  slots: ReplicationSlotState[]
  previousState: SlotMonitorState
  now: number
  retentionWarnBytes: number
  inactiveGraceMs: number
}): { warnings: SlotWarning[]; state: SlotMonitorState } => {
  const state: SlotMonitorState = {}
  const warnings: SlotWarning[] = []

  slots.forEach((slot) => {
    const retained = formatBytes(slot.retainedBytes)

    if (!slot.active) {
      // Every consumer restart makes its slot briefly inactive, so alerting on
      // a single observation pages on routine deploys - and an alarm that
      // pages on routine deploys gets muted, which is the state that let an
      // abandoned slot grow unnoticed in the first place. Only sustained
      // inactivity distinguishes abandoned from restarting.
      //
      // Carried forward from the previous observation, not reset, so the clock
      // starts when the slot first went quiet rather than on the latest poll.
      const since = previousState[slot.slotName] ?? now
      state[slot.slotName] = since

      if (now - since >= inactiveGraceMs) {
        warnings.push({
          slotName: slot.slotName,
          reason: 'inactive',
          message: `replication slot "${slot.slotName}" has been inactive for ${Math.round(
            (now - since) / 1000,
          )}s and is retaining ${retained} of WAL`,
        })
      }
    } else if (slot.retainedBytes >= retentionWarnBytes) {
      // No grace period here. Unlike inactivity, retention is cumulative
      // rather than transient - it does not resolve itself on the next poll.
      warnings.push({
        slotName: slot.slotName,
        reason: 'retention',
        message: `replication slot "${slot.slotName}" is retaining ${retained} of WAL`,
      })
    }

    // 'unreserved' means the slot has outrun max_slot_wal_keep_size and the WAL
    // it needs is a checkpoint away from deletion; 'lost' means it is already
    // gone. Reported separately because neither is a size question.
    if (slot.walStatus === 'unreserved' || slot.walStatus === 'lost') {
      warnings.push({
        slotName: slot.slotName,
        reason: 'wal_status',
        message: `replication slot "${slot.slotName}" has wal_status=${slot.walStatus}`,
      })
    }
  })

  // `state` is rebuilt from the slots just observed rather than merged into
  // the old one, so a slot that went active again, or was dropped, loses its
  // timer instead of accumulating forever.
  return { warnings, state }
}

// A single distinctive token, so a log-based alert can match one string rather
// than a shape that changes whenever the wording does.
export const SLOT_WARNING_MARKER = 'BEMI_SLOT_WARNING'

export const logSlotWarnings = (warnings: SlotWarning[]) => {
  warnings.forEach((warning) => {
    logger.info(`${SLOT_WARNING_MARKER} ${warning.reason}: ${warning.message}`)
  })
}
