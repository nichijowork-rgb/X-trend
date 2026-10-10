import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { httpError } from './store.js';
import { mergeSettings, DEFAULT_SETTINGS, ValidationError } from './settings.js';

export const BACKUP_FORMAT = 'x-trend-backup';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

export function createBackup({ store, settings, dataDir, clock }) {
  const dir = path.join(dataDir, 'backups');

  function exportJson() {
    return { format: BACKUP_FORMAT, version: 1, exportedAt: clock().toISOString(), settings: settings.get(), ...store.exportAll() };
  }

  function restore(backup, mode = 'replace') {
    if (mode !== 'replace' && mode !== 'merge') throw httpError(400, 'mode は replace か merge を指定してください');
    if (!backup || typeof backup !== 'object' || backup.format !== BACKUP_FORMAT || !Array.isArray(backup.posts)) {
      throw httpError(400, 'バックアップの形式が正しくありません');
    }
    let nextSettings = null;
    if (mode === 'replace' && backup.settings) {
      try {
        nextSettings = mergeSettings(structuredClone(DEFAULT_SETTINGS), backup.settings);
      } catch (e) {
        if (e instanceof ValidationError) throw httpError(400, `バックアップの設定が不正です: ${e.message}`);
        throw e;
      }
    }
    const restored = store.importAll(backup, mode, !!nextSettings);
    if (nextSettings) settings.replace(nextSettings);
    store.reclassifyAll();
    return { restored };
  }

  function listBackups() {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => NAME_RE.test(n))
      .map((name) => {
        const st = statSync(path.join(dir, name));
        return { name, size: st.size, createdAt: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  }

  function createAutoBackup(keep = 14) {
    mkdirSync(dir, { recursive: true });
    const stamp = clock().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
    const prefix = `x-trend-${stamp}-`;
    const seq = listBackups().reduce((m, b) => (b.name.startsWith(prefix) ? Math.max(m, parseInt(b.name.slice(prefix.length), 10) || 0) : m), 0) + 1;
    const name = `${prefix}${String(seq).padStart(3, '0')}.json`;
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify(exportJson()));
    const all = listBackups();
    for (const old of all.filter((b) => b.name !== name).slice(Math.max(1, keep) - 1)) {
      try {
        unlinkSync(path.join(dir, old.name));
      } catch {
        /* 削除失敗は無視 */
      }
    }
    return { name, size: statSync(file).size, pruned: Math.max(0, all.length - Math.max(1, keep)) };
  }

  function restoreFromFile(name, mode = 'replace') {
    if (!NAME_RE.test(String(name))) throw httpError(400, 'バックアップ名が正しくありません');
    const file = path.join(dir, name);
    if (!existsSync(file)) throw httpError(404, 'バックアップが見つかりません');
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw httpError(400, 'バックアップファイルを読み込めません');
    }
    return restore(data, mode);
  }

  return { exportJson, restore, listBackups, createAutoBackup, restoreFromFile };
}
