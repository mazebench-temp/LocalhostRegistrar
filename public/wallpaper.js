import { presets, validateUpload, WallpaperStore } from './wallpaper-store.js';

export async function initWallpapers(notice) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#wallpaper-dialog');
  const grid = $('#wallpaper-grid');
  const input = $('#wallpaper-input');
  const upload = $('#wallpaper-upload');
  const errorMessage = $('#wallpaper-error');
  const storageKey = 'localhost.wallpaper.v1';
  const store = new WallpaperStore();
  let selected = 'meadow';
  let uploads = [];
  let loaded = false;
  let loading;
  let selectionVersion = 0;
  try { selected = localStorage.getItem(storageKey) || selected; } catch { /* Use default. */ }
  const items = () => [...presets, ...uploads];
  function report(message) {
    if (!dialog.open) { notice(message); return; }
    errorMessage.textContent = message;
    errorMessage.hidden = false;
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  async function loadUploads() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      const records = await store.list();
      uploads = records.filter(record => record.blob instanceof Blob).sort((a, b) => a.createdAt - b.createdAt).map(record => ({ ...record, url: URL.createObjectURL(record.blob), custom: true }));
      loaded = true;
    })().finally(() => { loading = null; });
    return loading;
  }
  async function decode(url) {
    const image = new Image();
    image.src = url;
    try { await image.decode(); }
    catch { throw new Error('This image could not be opened. Try a different image.'); }
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('This image is empty.');
  }
  function markSelection() {
    for (const button of grid.querySelectorAll('[data-wallpaper]')) {
      const active = button.dataset.wallpaper === selected;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('selected', active);
    }
  }
  async function select(id, persist = true) {
    errorMessage.hidden = true;
    const version = ++selectionVersion;
    const item = items().find(item => item.id === id) || presets[0];
    if (item.url) await decode(item.url);
    if (version !== selectionVersion) return;
    selected = item.id;
    $('#wallpaper').style.backgroundImage = item.url ? `url("${item.url}")` : 'none';
    document.body.classList.toggle('has-wallpaper', !!item.url);
    markSelection();
    if (persist) {
      try { localStorage.setItem(storageKey, selected); }
      catch { report('Background changed for this visit. Browser storage is unavailable.'); }
      $('#announcement').textContent = `${item.name} background selected.`;
    }
  }
  function render() {
    grid.replaceChildren();
    for (const item of items()) {
      const tile = node('div', 'wallpaper-tile');
      const button = node('button', 'wallpaper-choice');
      button.type = 'button';
      button.dataset.wallpaper = item.id;
      button.setAttribute('aria-label', `Use ${item.name} background`);
      const preview = node('span', 'wallpaper-preview');
      if (item.url) {
        const image = node('img');
        image.src = item.url; image.alt = ''; image.loading = 'lazy';
        preview.append(image);
      }
      const check = node('span', 'wallpaper-check', '✓');
      check.setAttribute('aria-hidden', 'true');
      preview.append(check);
      button.append(preview, node('span', 'wallpaper-name', item.name));
      button.addEventListener('click', () => select(item.id).catch(error => report(error.message)));
      tile.append(button);
      if (item.custom) {
        const remove = node('button', 'wallpaper-remove', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove ${item.name}`);
        remove.title = `Remove ${item.name}`;
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try {
            await store.remove(item.id);
            // Cancel pending image selection before revoking a deleted URL.
            selectionVersion++;
            if (selected === item.id) await select('plain');
            uploads = uploads.filter(upload => upload.id !== item.id);
            render();
            URL.revokeObjectURL(item.url);
            $('#wallpaper-upload').focus();
          } catch (error) { remove.disabled = false; report(error.message || 'Could not remove this image.'); }
        });
        tile.append(remove);
      }
      grid.append(tile);
    }
    markSelection();
  }
  async function addFiles(files) {
    if (upload.disabled || !files.length) return;
    errorMessage.hidden = true;
    upload.disabled = true;
    upload.setAttribute('aria-busy', 'true');
    const errors = [];
    let last;
    try {
      await loadUploads();
      for (const file of files) {
        let url;
        try {
          validateUpload(file);
          url = URL.createObjectURL(file);
          await decode(url);
          const record = { id: crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'My image', blob: new Blob([file], { type: file.type }), createdAt: Date.now() };
          await store.put(record);
          last = { ...record, url, custom: true };
          uploads.push(last);
        } catch (error) {
          if (url) URL.revokeObjectURL(url);
          errors.push(`${file.name}: ${error.name === 'QuotaExceededError' ? 'Browser storage is full. Remove an image and try again.' : error.message || 'Could not save this image.'}`);
        }
      }
      render();
      if (last) await select(last.id);
      if (errors.length) report(errors.join(' '));
    } catch (error) { report(error.message || 'Image storage is unavailable.'); }
    finally { upload.disabled = false; upload.setAttribute('aria-busy', 'false'); input.value = ''; }
  }
  $('#wallpaper-button').addEventListener('click', async () => {
    errorMessage.hidden = true;
    render();
    dialog.showModal();
    try { await loadUploads(); render(); }
    catch { report('Uploaded images are unavailable. You can still choose a preset background.'); }
  });
  upload.addEventListener('click', () => input.click());
  input.addEventListener('change', () => addFiles([...input.files]));
  dialog.addEventListener('dragover', event => {
    if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); dialog.classList.add('drop-ready'); }
  });
  dialog.addEventListener('dragleave', event => { if (!dialog.contains(event.relatedTarget)) dialog.classList.remove('drop-ready'); });
  dialog.addEventListener('drop', event => {
    event.preventDefault(); dialog.classList.remove('drop-ready');
    addFiles([...event.dataTransfer.files]);
  });
  // Only custom selections need image storage during startup.
  if (!presets.some(item => item.id === selected)) {
    const version = selectionVersion;
    try { await loadUploads(); }
    catch { notice('Could not restore the uploaded background.'); }
    if (version !== selectionVersion) return;
  }
  await select(selected, false);
}
