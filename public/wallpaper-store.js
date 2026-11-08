export const presets = [
  { id: 'meadow', name: 'Meadow', url: '/backgrounds/meadow.png' },
  { id: 'coast', name: 'Coast', url: '/backgrounds/coast.png' },
  { id: 'dunes', name: 'Dunes', url: '/backgrounds/dunes.png' },
  { id: 'cave', name: 'Cave', url: '/backgrounds/cave.png' },
  { id: 'galaxies', name: 'Deep Space', url: '/backgrounds/galaxies.png' },
  { id: 'plain', name: 'Plain', url: null },
];

export function validateUpload(file) {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP, or AVIF image.');
  if (!file.size) throw new Error('This image is empty.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image smaller than 20 MB.');
}

// Store image bytes in IndexedDB, never in the repo or on a remote service.
export class WallpaperStore {
  constructor(factory = globalThis.indexedDB) { this.factory = factory; this.connection = null; }
  open() {
    if (!this.factory) return Promise.reject(new Error('Image storage is unavailable in this browser.'));
    if (this.connection) return this.connection;
    this.connection = new Promise((resolve, reject) => {
      const request = this.factory.open('localhost-wallpapers', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'id' });
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other Localhost tabs, then try uploading again.'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.connection = null; };
        resolve(db);
      };
    }).catch(error => { this.connection = null; throw error; });
    return this.connection;
  }
  async transaction(mode, action) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('images', mode);
      const request = action(transaction.objectStore('images'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error || request.error);
      transaction.onabort = () => reject(transaction.error || new Error('Could not save the image.'));
    });
  }
  list() { return this.transaction('readonly', store => store.getAll()); }
  put(record) { return this.transaction('readwrite', store => store.put(record)); }
  remove(id) { return this.transaction('readwrite', store => store.delete(id)); }
}
