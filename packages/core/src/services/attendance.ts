import type { Db } from '../db/connection.js';
import { dayEnd, dayStart, nowLocal } from '../domain/datetime.js';
import { audit } from './audit.js';

type Actor = { id: number; username: string };

export interface AttendanceRow {
  id: number;
  user_id: number;
  clock_in: string;
  clock_out: string | null;
  note: string | null;
  created_at: string;
  user_name?: string;
  minutes?: number | null;
}

/** Who is on the floor right now. */
export function openAttendance(db: Db): AttendanceRow[] {
  return db
    .prepare(
      `SELECT a.*, COALESCE(u.full_name, u.username) AS user_name
         FROM attendance a JOIN users u ON u.id = a.user_id
        WHERE a.clock_out IS NULL ORDER BY a.clock_in`,
    )
    .all() as AttendanceRow[];
}

export function listAttendance(
  db: Db,
  filter: { from?: string; to?: string; userId?: number | null; limit?: number } = {},
): AttendanceRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.from) {
    where.push('a.clock_in >= ?');
    params.push(dayStart(filter.from));
  }
  if (filter.to) {
    where.push('a.clock_in <= ?');
    params.push(dayEnd(filter.to));
  }
  if (filter.userId) {
    where.push('a.user_id = ?');
    params.push(filter.userId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT a.*, COALESCE(u.full_name, u.username) AS user_name,
              CASE WHEN a.clock_out IS NULL THEN NULL
                   ELSE CAST(ROUND((julianday(a.clock_out) - julianday(a.clock_in)) * 24 * 60) AS INTEGER) END AS minutes
         FROM attendance a JOIN users u ON u.id = a.user_id
         ${clause}
        ORDER BY a.clock_in DESC LIMIT ?`,
    )
    .all(...params, filter.limit ?? 200) as AttendanceRow[];
  return rows;
}

/** Clock in. One open record per user is enforced here, not in the UI. */
export function clockIn(db: Db, args: { userId?: number | null; note?: string | null; actor: Actor }): AttendanceRow {
  const userId = args.userId ?? args.actor.id;
  const open = db.prepare('SELECT id FROM attendance WHERE user_id = ? AND clock_out IS NULL').get(userId);
  if (open) throw new Error('এই কর্মচারী আগেই ক্লক-ইন করেছেন — আগে ক্লক-আউট করুন।');
  const now = nowLocal();
  const res = db
    .prepare('INSERT INTO attendance (user_id, clock_in, clock_out, note, created_at) VALUES (?,?,NULL,?,?)')
    .run(userId, now, args.note ?? null, now);
  audit(db, {
    userId: args.actor.id,
    username: args.actor.username,
    action: 'attendance.clock_in',
    entity: 'attendance',
    entityId: Number(res.lastInsertRowid),
    details: { userId, at: now },
  });
  return db.prepare('SELECT * FROM attendance WHERE id = ?').get(Number(res.lastInsertRowid)) as AttendanceRow;
}

export function clockOut(db: Db, args: { userId?: number | null; note?: string | null; actor: Actor }): AttendanceRow {
  const userId = args.userId ?? args.actor.id;
  const open = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(
    userId,
  ) as AttendanceRow | undefined;
  if (!open) throw new Error('ক্লক-ইন করা নেই — আগে ক্লক-ইন করুন।');
  db.prepare('UPDATE attendance SET clock_out = ?, note = COALESCE(?, note) WHERE id = ?').run(nowLocal(), args.note ?? null, open.id);
  audit(db, {
    userId: args.actor.id,
    username: args.actor.username,
    action: 'attendance.clock_out',
    entity: 'attendance',
    entityId: open.id,
    details: { userId, at: nowLocal() },
  });
  return db.prepare('SELECT * FROM attendance WHERE id = ?').get(open.id) as AttendanceRow;
}

/** Admin correction of a wrong punch, always audited. */
export function correctAttendance(
  db: Db,
  args: { id: number; clockIn?: string; clockOut?: string | null; note?: string | null; actor: Actor },
): AttendanceRow {
  const row = db.prepare('SELECT * FROM attendance WHERE id = ?').get(args.id) as AttendanceRow | undefined;
  if (!row) throw new Error('হাজিরার রেকর্ড পাওয়া যায়নি।');
  db.prepare('UPDATE attendance SET clock_in = ?, clock_out = ?, note = ? WHERE id = ?').run(
    args.clockIn ?? row.clock_in,
    args.clockOut !== undefined ? args.clockOut : row.clock_out,
    args.note !== undefined ? args.note : row.note,
    args.id,
  );
  audit(db, {
    userId: args.actor.id,
    username: args.actor.username,
    action: 'attendance.correct',
    entity: 'attendance',
    entityId: args.id,
    details: { before: { in: row.clock_in, out: row.clock_out }, after: { in: args.clockIn, out: args.clockOut } },
  });
  return db.prepare('SELECT * FROM attendance WHERE id = ?').get(args.id) as AttendanceRow;
}

export function attendanceSummary(db: Db, date = nowLocal().slice(0, 10)): {
  date: string;
  present: number;
  on_floor: number;
  total_minutes: number;
} {
  const rows = db
    .prepare(
      `SELECT clock_in, clock_out FROM attendance WHERE date(clock_in) = date(?)`,
    )
    .all(date) as { clock_in: string; clock_out: string | null }[];
  let minutes = 0;
  let onFloor = 0;
  for (const r of rows) {
    if (!r.clock_out) {
      onFloor++;
      continue;
    }
    minutes += Math.max(0, Math.round((new Date(r.clock_out).getTime() - new Date(r.clock_in).getTime()) / 60000));
  }
  return { date, present: rows.length, on_floor: onFloor, total_minutes: minutes };
}
