const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map();

function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }),
    );
  }
  return fmtCache.get(tz);
}

export function localParts(date, tz = 'Asia/Tokyo') {
  const o = {};
  for (const p of formatter(tz).formatToParts(date)) o[p.type] = p.value;
  const y = Number(o.year);
  const mo = Number(o.month);
  const d = Number(o.day);
  const h = Number(o.hour) % 24;
  const mi = Number(o.minute);
  const pad = (n) => String(n).padStart(2, '0');
  return { year: y, month: mo, day: d, hour: h, minute: mi, second: Number(o.second), weekday: WEEKDAYS[o.weekday], ymd: `${y}-${pad(mo)}-${pad(d)}`, hm: `${pad(h)}:${pad(mi)}` };
}

function offsetMs(tz, date) {
  const p = localParts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

export function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetMs(tz, new Date(guess));
  return new Date(guess - offsetMs(tz, new Date(first)));
}

export function startOfLocalDay(date, tz) {
  const p = localParts(date, tz);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, tz);
}

const hmOf = (t) => t.split(':').map(Number);

function jobTimes(settings) {
  const s = settings.schedule;
  const list = s.collectTimes.map((t) => ({ job: 'collect', time: t }));
  if (s.dailyDigest.enabled) list.push({ job: 'daily_digest', time: s.dailyDigest.time });
  if (s.weeklyDigest.enabled) list.push({ job: 'weekly_digest', time: s.weeklyDigest.time, weekday: s.weeklyDigest.weekday });
  if (s.autoBackup.enabled) list.push({ job: 'backup', time: s.autoBackup.time });
  return list;
}

// 今この瞬間に実行すべきスロット。予定時刻から windowMin 分以内のものだけ（古い分は追いかけない）。
export function dueSlots(settings, now, { windowMin = 30 } = {}) {
  const tz = settings.schedule.timezone;
  const p = localParts(now, tz);
  const out = [];
  for (const j of jobTimes(settings)) {
    if (j.weekday !== undefined && j.weekday !== p.weekday) continue;
    const [h, m] = hmOf(j.time);
    const at = zonedToUtc(p.year, p.month, p.day, h, m, tz);
    const diff = now.getTime() - at.getTime();
    if (diff >= 0 && diff <= windowMin * 60000) out.push({ job: j.job, slot: `${j.job}:${p.ymd}T${j.time}`, at });
  }
  return out;
}

export function nextRuns(settings, now) {
  const tz = settings.schedule.timezone;
  const p = localParts(now, tz);
  const best = new Map();
  for (let off = 0; off <= 8; off++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + off));
    const wd = day.getUTCDay();
    for (const j of jobTimes(settings)) {
      if (j.weekday !== undefined && j.weekday !== wd) continue;
      const [h, m] = hmOf(j.time);
      const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, m, tz);
      if (at.getTime() <= now.getTime()) continue;
      if (!best.has(j.job) || at < best.get(j.job)) best.set(j.job, at);
    }
  }
  return [...best.entries()].map(([job, at]) => ({ job, at: at.toISOString() })).sort((a, b) => (a.at < b.at ? -1 : 1));
}

export function createScheduler({ settings, jobs, clock, intervalMs = 30000, onError = () => {} }) {
  let timer = null;
  let ticking = false;
  async function tick() {
    if (ticking) return [];
    ticking = true;
    const ran = [];
    try {
      for (const s of dueSlots(settings.get(), clock())) {
        try {
          const run = await jobs.run(s.job, { slot: s.slot });
          if (run) ran.push(run);
        } catch (e) {
          onError(e);
        }
      }
    } finally {
      ticking = false;
    }
    return ran;
  }
  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick().catch(onError), intervalMs);
      timer.unref?.();
      void tick().catch(onError);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
