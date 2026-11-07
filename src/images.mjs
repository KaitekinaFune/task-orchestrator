import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RequestError } from './errors.mjs';

// The API counts an image by its base64 length and refuses a request above about 32 MB, so these limits keep every run sendable.
export const imageLimits = { perRequest: 5, perTask: 10, bytes: Math.floor(3.75 * 1024 * 1024), taskBytes: 15 * 1024 * 1024 };
export const imageRequestBytes = Math.ceil(imageLimits.taskBytes * 4 / 3) + 50000;
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// The type comes from the bytes, never from the browser's claim. SVG is left out: it is a document that can carry scripts.
export function imageType(bytes) {
  const starts = (signature, offset = 0) => bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}
export function decodeImages(input, existing = []) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new RequestError('Неверный список изображений', 400);
  if (input.length > imageLimits.perRequest) throw new RequestError(`За один раз можно приложить не больше ${imageLimits.perRequest} изображений`, 400);
  if (existing.length + input.length > imageLimits.perTask) throw new RequestError(`В одной задаче может быть не больше ${imageLimits.perTask} изображений`, 400);
  let total = existing.reduce((sum, image) => sum + image.size, 0);
  return input.map(item => {
    const data = item?.data;
    if (typeof data !== 'string' || !data || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new RequestError('Не удалось прочитать изображение', 400);
    const bytes = Buffer.from(data, 'base64'), type = imageType(bytes);
    if (!type) throw new RequestError('Поддерживаются только PNG, JPEG, GIF и WebP', 400);
    if (bytes.length > imageLimits.bytes) throw new RequestError('Изображение больше 3,75 МБ: уменьшите его и приложите снова', 400);
    total += bytes.length;
    if (total > imageLimits.taskBytes) throw new RequestError('Изображения задачи вместе занимают больше 15 МБ', 400);
    return { bytes, type };
  });
}

// Lives in the application's data directory: pictures must not appear in the user's checkout or in its snapshots.
export function createImageStore(directory) {
  const folder = taskId => { if (!validId(taskId)) throw new RequestError('Неверный идентификатор задачи', 400); return resolve(directory, taskId); };
  const path = (taskId, image) => {
    if (!validId(image?.id) || !extensions[image.type]) throw new RequestError('Изображение не найдено', 404);
    return resolve(folder(taskId), `${image.id}.${extensions[image.type]}`);
  };
  return {
    path,
    read: (taskId, image) => readFile(path(taskId, image)),
    async save(taskId, decoded) {
      if (!decoded.length) return [];
      await mkdir(folder(taskId), { recursive: true });
      const saved = [];
      try {
        for (const { bytes, type } of decoded) {
          const image = { id: randomUUID(), type, size: bytes.length }, target = path(taskId, image), temp = `${target}.tmp`;
          await writeFile(temp, bytes, { mode: 0o600 });
          await rename(temp, target);
          saved.push(image);
        }
      } catch (error) { await Promise.all(saved.map(image => rm(path(taskId, image), { force: true }))).catch(() => {}); throw error; }
      return saved;
    },
    async remove(taskIds) { await Promise.all(taskIds.map(id => rm(folder(id), { recursive: true, force: true, maxRetries: 3 }))); }
  };
}
