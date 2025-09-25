// +page.server.ts
import type { PageServerLoad } from '../$types';
import { randomUUID } from 'crypto';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ cookies, fetch }) => {
  let cookieId = cookies.get('public_user_id');
  if (!cookieId) {
    cookieId = randomUUID();
    cookies.set('public_user_id', cookieId, { path: '/', maxAge: 60 * 60 * 24 * 365 }); // 1 year
  }

  const backendUrl = env.BACKEND_URL || 'http://localhost:3010';

  // fetch prior conversations for this user (optional)
  let conversations: any[] = [];
  try {
    const r = await fetch(`${backendUrl}/chat/conversations?userId=${encodeURIComponent(cookieId)}`);
    const d = await r.json();
    if (r.ok && Array.isArray(d?.conversations)) conversations = d.conversations;
  } catch { /* non-fatal */ }

  return {
    userId: cookieId,
    backendUrl,
    conversations
  };
};