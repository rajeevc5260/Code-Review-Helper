import { json, type RequestHandler } from '@sveltejs/kit';
import { trelae } from '$lib/utils/trelae';
import { env } from '$env/dynamic/private';

const EXT_NAMESPACE_ID = env.EXT_NAMESPACE_ID || '';

type TrelaeApi = {
  unzipSync: (args: {
    fileId: string;
    namespaceId: string;
    location: string;
    poll?: { intervalMs?: number; timeoutMs?: number };
  }) => Promise<{ status: string; operationId: string; source: unknown; meta: any }>;

  zipSync: (args: {
    fileIds: string[];
    namespaceId: string;
    zipName: string;
    poll?: { intervalMs: number; timeoutMs: number };
  }) => Promise<{ status: string; operationId: string; file: { id: string; name?: string }; meta: any }>;

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
      pagination: Array<{ limit: number; page: number }>;
      totalCount: number;
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

// Recursively collect ALL file IDs under a location
async function collectAllFileIds(namespaceId: string, rootLocation: string): Promise<string[]> {
  const queue: string[] = [rootLocation.replace(/^\/+|\/+$/g, '')];
  const ids: string[] = [];
  while (queue.length) {
    const loc = queue.shift()!;
    let page = 1;
    const limit = 100;
    while (true) {
      const res = await t.namespace(namespaceId).getFiles({ location: loc, limit, page });
      (res.files || []).forEach((f) => ids.push(f.id));
      (res.folders || []).forEach((f) => {
        const next = `${(f.location || '').replace(/^\/+|\/+$/g, '')}/${f.name}`.replace(/^\/+/, '');
        queue.push(next);
      });
      const total = res.totalCount ?? (res.files?.length || 0) + (res.folders?.length || 0);
      const maxPage = res.pagination?.length ? Math.max(...res.pagination.map((p) => p.page)) : page;
      if ((res.files?.length ?? 0) + (res.folders?.length ?? 0) < limit || page >= maxPage) break;
      page += 1;
    }
  }
  return Array.from(new Set(ids));
}

// ------- helpers for versioned names -------
function ensureZipExt(name: string) {
  return /\.zip$/i.test(name) ? name : `${name}.zip`;
}
function versionedName(baseZipName: string, n: number) {
  const m = baseZipName.match(/^(.*?)(?:\s\((\d+)\))?(\.zip)?$/i);
  const base = (m?.[1] || baseZipName.replace(/\.zip$/i, '')).trim();
  const ext = m?.[3] || '.zip';
  return n <= 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
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

  // 3) Unzip
  if (action === 'unzip') {
    const { fileId } = body;
    if (!fileId) return json({ error: 'fileId is required' }, { status: 400 });

    await waitUploadReady(fileId);
    const dest = `CodeZips/${shortId()}`;

    try {
      await unzipWithRetries(fileId, EXT_NAMESPACE_ID, dest);
      return json({ success: true, location: dest });
    } catch (e: any) {
      return json({ error: 'unzip-failed', message: e?.message || 'UNZIP failed' }, { status: 500 });
    }
  }

  // 4) List
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
    return json({
      success: true,
      files: res.files || [],
      folders: res.folders || [],
      pagination: res.pagination,
      totalCount: res.totalCount
    });
  }

  // 5) Zip entire folder recursively with versioned name
  if (action === 'zipFolder') {
    const { location, zipName } = body;
    if (!location) return json({ error: 'location is required' }, { status: 400 });

    const requested = ensureZipExt((zipName && String(zipName).trim()) || `archive-${shortId()}.zip`);

    // collect all file IDs under the folder
    const fileIds = await collectAllFileIds(EXT_NAMESPACE_ID, location);
    if (fileIds.length === 0) {
      return json({ error: 'No files found to zip at the specified location' }, { status: 400 });
    }

    // Try with versioned names until success
    let attempt = 1;
    let lastErr: any;
    while (attempt <= 50) {
      const candidate = versionedName(requested, attempt);
      try {
        const zipRes = await t.zipSync({
          fileIds,
          namespaceId: EXT_NAMESPACE_ID,
          zipName: candidate,
          poll: { intervalMs: 2000, timeoutMs: 10 * 60 * 1000 }
        });
        if (zipRes?.status === 'completed' && zipRes?.file?.id) {
          const downloadUrl = await t.file(zipRes.file.id).getDownloadUrl();
          return json({ success: true, url: downloadUrl, fileId: zipRes.file.id, name: candidate });
        }
        lastErr = new Error('zip-not-completed');
      } catch (e: any) {
        // If file already exists, bump the version and retry
        const msg = (e?.message || '').toLowerCase();
        const code = (e?.error || e?.code || '').toLowerCase();
        if (msg.includes('already exists') || code === 'file-already-exists') {
          attempt += 1;
          continue;
        }
        lastErr = e;
      }
      attempt += 1;
    }

    return json(
      { error: 'zip-failed', message: lastErr?.message || 'Unable to create a unique zip name' },
      { status: 500 }
    );
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