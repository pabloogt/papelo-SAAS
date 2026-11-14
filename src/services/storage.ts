import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Almacenamiento de ficheros en disco local (volumen persistente).
// Interfaz pensada para poder cambiarla por S3/R2 sin tocar las rutas.
export type Storage = {
  put(orgId: string, fileId: string, data: Uint8Array): Promise<void>;
  get(orgId: string, fileId: string): Promise<Buffer>;
  remove(orgId: string, fileId: string): Promise<void>;
  removeOrg(orgId: string): Promise<void>;
};

const SAFE_ID = /^[0-9a-f-]{36}$/;

export function createDiskStorage(root: string): Storage {
  const base = resolve(root);
  const pathFor = (orgId: string, fileId?: string) => {
    if (!SAFE_ID.test(orgId) || (fileId !== undefined && !SAFE_ID.test(fileId))) throw new Error('Identificador inválido');
    return fileId ? join(base, orgId, fileId) : join(base, orgId);
  };
  return {
    async put(orgId, fileId, data) {
      await mkdir(pathFor(orgId), { recursive: true });
      await writeFile(pathFor(orgId, fileId), data, { flag: 'wx' });
    },
    get: (orgId, fileId) => readFile(pathFor(orgId, fileId)),
    remove: (orgId, fileId) => rm(pathFor(orgId, fileId), { force: true }),
    removeOrg: (orgId) => rm(pathFor(orgId), { recursive: true, force: true }),
  };
}

export const ALLOWED_EXTENSIONS: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  txt: 'text/plain',
  xml: 'application/xml',
  zip: 'application/zip',
};

// Comprueba extensión permitida y, para los formatos más habituales, la firma binaria (magic bytes).
export function validateUpload(name: string, data: Uint8Array): { ok: true; mime: string; ext: string } | { ok: false; error: string } {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const mime = ALLOWED_EXTENSIONS[ext];
  if (!mime || !name.includes('.')) return { ok: false, error: `Tipo de archivo no permitido (.${ext}).` };
  if (data.length === 0) return { ok: false, error: 'El archivo está vacío.' };
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  const signatureOk =
    ext === 'pdf' ? starts(0x25, 0x50, 0x44, 0x46) :
    ext === 'png' ? starts(0x89, 0x50, 0x4e, 0x47) :
    ext === 'jpg' || ext === 'jpeg' ? starts(0xff, 0xd8, 0xff) :
    ['xlsx', 'docx', 'zip', 'odt', 'ods'].includes(ext) ? starts(0x50, 0x4b) :
    true;
  if (!signatureOk) return { ok: false, error: 'El contenido del archivo no coincide con su extensión.' };
  return { ok: true, mime, ext };
}

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'archivo').slice(0, 180);
}
