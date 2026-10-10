import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const digest = (s) => createHash('sha256').update(String(s)).digest();
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return timingSafeEqual(digest(a), digest(b));
}

export function createAuth({ env, meta }) {
  const adminToken = env.ADMIN_TOKEN ? String(env.ADMIN_TOKEN) : '';
  const authRequired = adminToken.length > 0;

  function shareToken() {
    let t = meta.get('share_token');
    if (!t) {
      t = randomBytes(24).toString('base64url');
      meta.set('share_token', t);
    }
    return t;
  }
  function rotate() {
    const t = randomBytes(24).toString('base64url');
    meta.set('share_token', t);
    return t;
  }
  // 戻り値: 'admin' | 'viewer' | null
  function roleOf(headers) {
    if (!authRequired) return 'admin';
    if (safeEqual(String(headers['x-admin-token'] ?? ''), adminToken)) return 'admin';
    if (safeEqual(String(headers['x-share-token'] ?? ''), shareToken())) return 'viewer';
    return null;
  }
  function shareUrl(origin) {
    return authRequired ? `${origin}/?share=${shareToken()}` : null;
  }
  return { authRequired, roleOf, rotate, shareUrl };
}
