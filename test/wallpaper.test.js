import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateUpload, WallpaperStore, presets } from '../public/wallpaper-store.js';
import { createLauncher } from '../src/server.js';

test('wallpaper uploads accept supported images and reject empty, oversized, or other files', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/avif']) {
    assert.doesNotThrow(() => validateUpload({ type, size: 20 * 1024 * 1024 }));
  }
  assert.throws(() => validateUpload({ type: 'text/html', size: 100 }), /PNG, JPEG, WebP, or AVIF/);
  assert.throws(() => validateUpload({ type: 'image/svg+xml', size: 100 }), /PNG, JPEG, WebP, or AVIF/);
  assert.throws(() => validateUpload({ type: 'image/png', size: 0 }), /empty/);
  assert.throws(() => validateUpload({ type: 'image/png', size: 20 * 1024 * 1024 + 1 }), /20 MB/);
});

test('unavailable browser image storage reports an actionable error', async () => {
  await assert.rejects(new WallpaperStore(null).list(), /unavailable in this browser/);
});

test('wallpaper modules and preset images are served, with local uploaded images allowed by CSP', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localhost-wallpaper-'));
  const launcher = await createLauncher({ root, listenPort: 0, includeSelf: false });
  t.after(async () => { await launcher.close(); await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${launcher.server.address().port}`;
  const page = await fetch(url);
  assert.match(page.headers.get('content-security-policy'), /img-src 'self' data: blob:/);
  for (const name of ['wallpaper.js', 'wallpaper-store.js']) {
    const response = await fetch(`${url}/${name}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/javascript/);
    assert.ok((await response.text()).length);
  }
  for (const preset of presets.filter(item => item.url)) {
    const response = await fetch(url + preset.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/png/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  assert.equal((await fetch(`${url}/backgrounds/prompts.txt`)).status, 404);
});
