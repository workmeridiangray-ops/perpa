export type Resource = { id: string; dailyMinutes: number; weeklyMinutes: number[] | null };
export type Leave = { resourceId: string; startsOn: string; endsOn: string; status: string };
export type Booking = { resourceId: string; startsOn: string; endsOn: string; minutesPerDay: number; status: "tentative" | "confirmed" };

const isoDow = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };

/** Mirrors the database's app.day_capacity: pattern (or Mon–Fri default) minus approved leave. */
export function dayCapacity(r: Resource, leave: Leave[], day: string): number {
  if (leave.some((l) => l.resourceId === r.id && l.status === "approved" && day >= l.startsOn && day <= l.endsOn)) return 0;
  const dow = isoDow(day);
  return r.weeklyMinutes?.[dow - 1] ?? (dow <= 5 ? r.dailyMinutes : 0);
}

export type Cell = { capacity: number; confirmed: number; tentative: number; state: "off" | "free" | "ok" | "full" | "over" };

export function cell(r: Resource, leave: Leave[], bookings: Booking[], day: string): Cell {
  const capacity = dayCapacity(r, leave, day);
  const on = bookings.filter((b) => b.resourceId === r.id && day >= b.startsOn && day <= b.endsOn);
  const confirmed = on.filter((b) => b.status === "confirmed").reduce((s, b) => s + b.minutesPerDay, 0);
  const tentative = on.filter((b) => b.status === "tentative").reduce((s, b) => s + b.minutesPerDay, 0);
  const state = confirmed > capacity ? "over" : capacity === 0 ? "off" : confirmed === capacity ? "full" : confirmed + tentative === 0 ? "free" : "ok";
  return { capacity, confirmed, tentative, state };
}

export function daysFrom(start: string, n: number): string[] {
  const t = new Date(`${start}T00:00:00Z`).getTime();
  return Array.from({ length: n }, (_, i) => new Date(t + i * 86_400_000).toISOString().slice(0, 10));
}
