// Admin sessions and brute-force protection. No session store: the admin
// cookie carries its expiry signed with the admin password, so changing the
// password invalidates every session.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function createAdminSessions({ password, now, maxAgeMs }) {
  const sign = (expiresAt) => createHmac('sha256', password).update(String(expiresAt)).digest('hex');

  return {
    checkPassword(candidate) {
      if (typeof candidate !== 'string') return false;
      const digest = (value) => createHash('sha256').update(value).digest();
      return timingSafeEqual(digest(candidate), digest(password));
    },

    issue() {
      const expiresAt = now() + maxAgeMs;
      return `${expiresAt}.${sign(expiresAt)}`;
    },

    verify(cookieValue) {
      const match = typeof cookieValue === 'string' && /^(\d{1,16})\.([0-9a-f]{64})$/.exec(cookieValue);
      if (!match) return false;
      const expiresAt = Number(match[1]);
      if (expiresAt <= now()) return false;
      return timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(sign(expiresAt), 'hex'));
    },
  };
}

/** Sliding-window failure counter per client IP, in memory. */
export function createFailureLimiter({ maxFailures, windowMs, now }) {
  const failures = new Map(); // ip → timestamps (ms), oldest first

  function recent(ip) {
    const since = now() - windowMs;
    const kept = (failures.get(ip) ?? []).filter((at) => at > since);
    if (kept.length > 0) failures.set(ip, kept);
    else failures.delete(ip);
    return kept;
  }

  return {
    isBlocked(ip) {
      return recent(ip).length >= maxFailures;
    },

    recordFailure(ip) {
      failures.set(ip, [...recent(ip), now()]);
      if (failures.size > 10_000) {
        for (const key of failures.keys()) recent(key);
      }
    },
  };
}
