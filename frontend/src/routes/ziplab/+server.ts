import { json, type RequestHandler } from '@sveltejs/kit';
import { trelae } from '$lib/utils/trelae';
import { env } from '$env/dynamic/private';
import { GoogleGenAI } from '@google/genai';

const GOOGLE_API_KEY = env.GOOGLE_API_KEY || '';
const EXT_NAMESPACE_ID = env.EXT_NAMESPACE_ID || '';
const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

type TrelaeApi = {
  unzipSync: (args: {
    fileId: string;
    namespaceId: string;
    location: string; // folder (you may include a trailing slash)
    poll?: { intervalMs?: number; timeoutMs?: number };
  }) => Promise<{ status: string; operationId: string; source: unknown; meta: any }>;

  file: (id: string) => {
    getDownloadUrl: () => Promise<string>;
    getMetaData: () => Promise<any>;
  };

  namespace: (ns: string) => {
    getUploadUrl: (args: { name: string; location?: string }) => Promise<{ id: string; uploadUrl: string }>;
    startMultipartUpload: (args: {
      name: string;
      location?: string;
      size: number;
      fileType: string;
    }) => Promise<{
      id: string;
      uploadId: string;
      partSize: number;
      partCount: number;
      urls: { partNumber: number; url: string }[];
    }>;
    completeMultipartUpload: (args: {
      fileId: string;
      uploadId: string;
      parts: { partNumber: number; etag: string }[];
    }) => Promise<unknown>;
    getFiles: (args: {
      limit: number;
      page: number;
      location: string;
    }) => Promise<{
      files: Array<{ id: string; name: string; size?: number; location?: string; mimeType?: string }>;
      folders: Array<{ name: string; location: string }>;
    }>;
  };
};

const t = trelae as unknown as TrelaeApi;

const shortId = () => crypto.randomUUID().split('-')[0];
const withSlash = (p: string) => (p.endsWith('/') ? p : p + '/');

function looksReady(meta: any): boolean {
  if (!meta || typeof meta !== 'object') return false;
  if (meta.status && /ready|complete|uploaded/i.test(meta.status)) return true;
  if (meta.ready === true || meta.uploadCompleted === true) return true;
  if (Number.isFinite(meta?.size) && Number.isFinite(meta?.uploadedSize) && meta.uploadedSize >= meta.size) return true;
  if (Array.isArray(meta.completedParts) && Array.isArray(meta.parts) && meta.completedParts.length === meta.parts.length) return true;
  return false;
}

async function waitUploadReady(fileId: string, timeoutMs = 90_000, intervalMs = 1_500) {
  const started = Date.now();
  while (true) {
    const meta = await t.file(fileId).getMetaData().catch(() => null);
    if (looksReady(meta)) return;
    if (Date.now() - started > timeoutMs) throw new Error('Upload not ready (timeout)');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function unzipWithRetries(fileId: string, namespaceId: string, location: string) {
  // brief grace delay for object-store consistency
  await new Promise((r) => setTimeout(r, 1200));
  let lastErr: any;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await t.unzipSync({
        fileId,
        namespaceId,
        location: withSlash(location),
        poll: { intervalMs: 2000, timeoutMs: 10 * 60 * 1000 }
      });
      if (res?.status === 'completed') return res;
      lastErr = new Error(`unzip status=${res?.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
  }
  throw lastErr || new Error('unzip failed');
}

/* ------------------------------- Handlers ------------------------------- */

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({} as any));
  const { action, name, type, size } = body || {};

  // 1) Upload bootstrap
  if (name && size != null && !action) {
    const base = 'CodeZips';
    const finalName = `${shortId()}_${name}`;
    const FIVE_MB = 5 * 1024 * 1024;

    if (Number(size) < FIVE_MB) {
      const { id, uploadUrl } = await t.namespace(EXT_NAMESPACE_ID).getUploadUrl({
        name: finalName,
        location: base
      });
      return json({ mode: 'single', uploadUrl, fileId: id, name: finalName, type });
    }

    const start = await t.namespace(EXT_NAMESPACE_ID).startMultipartUpload({
      name: finalName,
      location: base,
      size: Number(size),
      fileType: type || 'application/zip'
    });

    return json({
      mode: 'multipart',
      fileId: start.id,
      uploadId: start.uploadId,
      partSize: start.partSize,
      partCount: start.partCount,
      urls: start.urls,
      name: finalName,
      type
    });
  }

  // 2) Complete multipart
  if (action === 'completeMultipart') {
    const { fileId, uploadId, parts } = body;
    if (!fileId || !uploadId || !Array.isArray(parts) || parts.length === 0) {
      return json({ error: 'Missing multipart completion data' }, { status: 400 });
    }
    await t.namespace(EXT_NAMESPACE_ID).completeMultipartUpload({ fileId, uploadId, parts });
    return json({ success: true });
  }

  // 3) Unzip → return location only (client will poll + paginate)
  if (action === 'unzip') {
    const { fileId } = body;
    if (!fileId) return json({ error: 'fileId is required' }, { status: 400 });

    await waitUploadReady(fileId);
    const dest = `CodeZips/${shortId()}`; // folder for this extraction

    try {
      await unzipWithRetries(fileId, EXT_NAMESPACE_ID, dest);
      return json({ success: true, location: dest }); // client will list from here
    } catch (e: any) {
      return json(
        { error: 'unzip-failed', message: e?.message || 'UNZIP failed' },
        { status: 500 }
      );
    }
  }

  // 4) List (ONLY the params you said: limit, page, location)
  if (action === 'list') {
    const { location, limit, page } = body;
    if (!location) return json({ error: 'location is required' }, { status: 400 });
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
    const safePage = Math.max(1, Number(page) || 1);

    const res = await t.namespace(EXT_NAMESPACE_ID).getFiles({
      location,
      limit: safeLimit,
      page: safePage
    });
    return json({ success: true, files: res.files || [], folders: res.folders || [] });
  }

  return json({ error: 'Unsupported request' }, { status: 400 });
};

export const GET: RequestHandler = async ({ url }) => {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id is required' }, { status: 400 });

  try {
    const link = await t.file(id).getDownloadUrl();
    return json({ url: link });
  } catch (e: any) {
    return json({ error: e?.message || 'failed to get url' }, { status: 500 });
  }
}; 