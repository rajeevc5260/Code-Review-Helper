// +page.server.ts
import type { PageServerLoad } from './$types';
import { randomUUID } from 'crypto';
import { env } from '$env/dynamic/private';

const ONE_YEAR = 60 * 60 * 24 * 365;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ensureUuid(v: string | undefined | null): string {
  if (v && UUID_RE.test(v.trim())) return v.trim().toLowerCase();
  return randomUUID(); // canonical v4
}

export const load: PageServerLoad = async ({ cookies }) => {
  let cookieId = cookies.get('public_user_id');
  const validId = ensureUuid(cookieId);

  // (Re)write if missing/invalid (keeps value canonical)
  if (cookieId !== validId) {
    cookies.set('public_user_id', validId, {
      path: '/',
      maxAge: ONE_YEAR,
      httpOnly: true,
      sameSite: 'lax',
      secure: (env.NODE_ENV || '').toLowerCase() === 'production'
    });
  }

  // backend URL from env (fallback to localhost)
  const backendUrl = env.BACKEND_URL || 'http://localhost:3010';

  return {
    userId: validId,
    backendUrl
  };
};