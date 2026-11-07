import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageStore, decodeImages, imageLimits, imageType } from '../src/images.mjs';
import { claudeArgs, claudeInput } from '../src/claude.mjs';
import { codexArgs } from '../src/codex.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARQMCAQSnv6IAAAAASUVORK5CYII=', 'base64');
const encoded = bytes => ({ data: bytes.toString('base64') });
const id = '11111111-1111-4111-8111-111111111111';

test('the type comes from the bytes, and a script dressed as a picture is refused', () => {
  assert.equal(imageType(png), 'image/png');
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WAVEfmt ')), null);
  assert.equal(imageType(Buffer.from('<svg onload="alert(1)"/>')), null);
  assert.throws(() => decodeImages([encoded(Buffer.from('<svg onload="alert(1)"/>'))]), { status: 400 });
});

test('limits and malformed input are refused with the reason', () => {
  assert.deepEqual(decodeImages(undefined), []);
  assert.throws(() => decodeImages('text'), { status: 400 });
  for (const bad of [{}, { data: 7 }, { data: 'not base64!' }, { data: 'abc' }]) assert.throws(() => decodeImages([bad]), { status: 400 });
  assert.equal(decodeImages([encoded(png)])[0].type, 'image/png');
  assert.throws(() => decodeImages(Array(imageLimits.perRequest + 1).fill(encoded(png))), /За один раз/);
  const big = Buffer.concat([png, Buffer.alloc(imageLimits.bytes)]);
  assert.throws(() => decodeImages([encoded(big)]), /3,75 МБ/);
  const existing = Array(imageLimits.perTask).fill({ size: 1 });
  assert.throws(() => decodeImages([encoded(png)], existing), /не больше 10/);
  assert.throws(() => decodeImages([encoded(png)], [{ size: imageLimits.taskBytes }]), /15 МБ/);
});

test('pictures are stored per task under server-made names and leave with the task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-orchestrator-images-'));
  try {
    const store = createImageStore(dir), [image] = await store.save(id, decodeImages([encoded(png)]));
    assert.equal(image.type, 'image/png'); assert.equal(image.size, png.length);
    assert.deepEqual(await store.read(id, image), png);
    assert.throws(() => store.path('../outside', image), { status: 400 });
    assert.throws(() => store.path(id, { ...image, id: '..\\..\\state' }), { status: 404 });
    assert.throws(() => store.path(id, { ...image, type: 'text/html' }), { status: 404 });
    assert.deepEqual(await store.save(id, []), []);
    await store.remove([id]);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Claude gets pictures in its streaming input and a plain prompt otherwise', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-orchestrator-images-'));
  try {
    const path = join(dir, 'a.png'); await writeFile(path, png);
    assert.equal(claudeInput('Текст'), 'Текст');
    assert.ok(!claudeArgs({ profile: 'subscription' }).includes('--input-format'), 'a run without pictures stays as it was');
    assert.deepEqual(claudeArgs({ profile: 'subscription', images: [{ path, type: 'image/png' }] }).slice(0, 3), ['--print', '--input-format', 'stream-json']);
    const line = claudeInput('Текст', [{ path, type: 'image/png' }]);
    assert.ok(line.endsWith('\n')); assert.equal(line.trim().split('\n').length, 1);
    const { type, message } = JSON.parse(line);
    assert.equal(type, 'user'); assert.equal(message.role, 'user');
    assert.deepEqual(message.content.map(block => block.type), ['image', 'text']);
    assert.deepEqual(message.content[0].source, { type: 'base64', media_type: 'image/png', data: png.toString('base64') });
    assert.equal(message.content[1].text, 'Текст');
    assert.equal((await readFile(path)).length, png.length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Codex gets each picture in one argument, so the stdin marker stays last', () => {
  const images = [{ path: 'C:/data/a.png' }, { path: 'C:/data/b.png' }];
  const args = codexArgs({ images });
  assert.deepEqual(args.slice(-3), ['--image=C:/data/a.png', '--image=C:/data/b.png', '-']);
  const resumed = codexArgs({ images, resumeSessionId: id });
  assert.deepEqual(resumed.slice(-3), ['--image=C:/data/a.png', '--image=C:/data/b.png', '-']);
  assert.ok(resumed.indexOf('resume') < resumed.indexOf('--image=C:/data/a.png'));
  assert.throws(() => codexArgs({ images: [{ path: 'C:/da,ta/a.png' }] }), /comma/);
  assert.ok(!codexArgs().some(arg => arg.startsWith('--image')));
});
