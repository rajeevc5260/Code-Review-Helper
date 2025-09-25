// src/routes/document-analyser/+server.ts
import { json, type RequestHandler } from '@sveltejs/kit';
import { trelae } from '$lib/utils/trelae';
import { env } from '$env/dynamic/private';

const CA_NAMESPACE_ID = env.CA_NAMESPACE_ID || '';

/** Accept only Word or PDF */
const ALLOWED_MIME = new Set<string>([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);
const ALLOWED_EXT = /\.(pdf|doc|docx)$/i;

/** Trelae surface we use in this route */
type TrelaeApi = {
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

    /** Basic folder listing (no content search) */
    getFiles: (args: {
      limit: number;
      page: number;
      location: string;
    }) => Promise<{
      files: Array<{ id: string; name: string; size?: number; location?: string; mimeType?: string }>;
      folders: Array<{ name: string; location: string }>;
      pagination: Array<{ limit: number; page: number }>;
      totalCount: number;
    }>;
  };
};

const t = trelae as unknown as TrelaeApi;

const shortId = () => crypto.randomUUID().split('-')[0];

/** Heuristic used to flip UI "Verify" -> Complete once the object is fully present */
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

/* ------------------------------- Handlers ------------------------------- */

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({} as any));
  const { action, name, type, size } = body || {};

  // 0) Early validation (PDF/DOC/DOCX)
  if (name && size != null && !action) {
    const mime = String(type || '').toLowerCase();
    const okMime = ALLOWED_MIME.has(mime);
    const okExt = ALLOWED_EXT.test(String(name));
    if (!okMime && !okExt) {
      return json({ error: 'Only PDF or Word files are allowed (.pdf, .doc, .docx)' }, { status: 400 });
    }
  }

  // 1) Upload bootstrap (simple vs multipart) — mirrors ziplab bootstrap
  if (name && size != null && !action) {
    if (!CA_NAMESPACE_ID) {
      return json({ error: 'Server misconfigured: CA_NAMESPACE_ID is missing' }, { status: 500 });
    }

    const base = 'DocUploads';
    const finalName = `${shortId()}_${name}`;
    const FIVE_MB = 5 * 1024 * 1024;

    if (Number(size) < FIVE_MB) {
      const { id, uploadUrl } = await t.namespace(CA_NAMESPACE_ID).getUploadUrl({
        name: finalName,
        location: base
      });
      return json({ mode: 'single', uploadUrl, fileId: id, name: finalName, type });
    }

    const start = await t.namespace(CA_NAMESPACE_ID).startMultipartUpload({
      name: finalName,
      location: base,
      size: Number(size),
      fileType: type || 'application/octet-stream'
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

  // 2) Complete multipart (wait for ready so the UI "Verify" stripe snaps to complete)
  if (action === 'completeMultipart') {
    const { fileId, uploadId, parts } = body;
    if (!fileId || !uploadId || !Array.isArray(parts)) {
      return json({ error: 'Missing multipart completion data' }, { status: 400 });
    }
    await t.namespace(CA_NAMESPACE_ID).completeMultipartUpload({ fileId, uploadId, parts });
    try { await waitUploadReady(fileId); } catch { /* non-fatal */ }
    return json({ success: true });
  }

  // 3) Meta poll for UI
  if (action === 'meta') {
    const { fileId } = body;
    if (!fileId) return json({ error: 'fileId is required' }, { status: 400 });
    const meta = await t.file(fileId).getMetaData().catch(() => null);
    return json({ meta, ready: looksReady(meta) });
  }

  // 4) Optional: list a namespace folder (helpful to browse DocUploads/<run>)
  if (action === 'list') {
    const { location, limit, page } = body || {};
    if (!location || typeof location !== 'string') {
      return json({ error: 'location is required' }, { status: 400 });
    }
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
    const safePage = Math.max(1, Number(page) || 1);

    const res = await t.namespace(CA_NAMESPACE_ID).getFiles({
      location,
      limit: safeLimit,
      page: safePage
    });

    return json({
      success: true,
      files: res.files || [],
      folders: res.folders || [],
      pagination: res.pagination || [],
      totalCount: res.totalCount ?? 0
    });
  }

  return json({ error: 'Unsupported request' }, { status: 400 });
};

export const GET: RequestHandler = async ({ url }) => {
  // GET ?id=... -> signed download URL for a file
  const id = url.searchParams.get('id');
  if (id) {
    try {
      const link = await t.file(id).getDownloadUrl();
      return json({ url: link });
    } catch (e: any) {
      return json({ error: e?.message || 'failed to get url' }, { status: 500 });
    }
  }

  // GET ?ns=1 -> reveal namespace id for docs analyzer SSE backend
  if (url.searchParams.has('ns')) {
    if (!CA_NAMESPACE_ID) {
      return json({ error: 'Server misconfigured: CA_NAMESPACE_ID is missing' }, { status: 500 });
    }
    return json({ namespaceId: CA_NAMESPACE_ID });
  }

  return json({ error: 'id or ns query param required' }, { status: 400 });
};