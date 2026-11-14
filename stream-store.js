// Short-lived source metadata only. No video bytes, frames or offline cache.
(() => {
  let opening;
  function open() {
    if (!opening)
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open("disk-play-streams", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("sources", { keyPath: "token" });
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            opening = null;
          };
          resolve(db);
        };
        request.onerror = () => {
          opening = null;
          reject(request.error);
        };
        request.onblocked = () => {
          opening = null;
          reject(new Error("Storage is busy"));
        };
      });
    return opening;
  }
  async function operation(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sources", mode),
        store = tx.objectStore("sources");
      const request = action(store);
      let result;
      if (request)
        request.onsuccess = () => {
          result = request.result;
        };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () =>
        reject(tx.error || new Error("Storage failed"));
    });
  }
  globalThis.StreamStore = {
    get: (token) =>
      operation("readonly", (store) => store.get(token)).then(
        (value) => value?.entry,
      ),
    put: (token, entry) =>
      operation("readwrite", (store) => store.put({ token, entry })),
    delete: (token) => operation("readwrite", (store) => store.delete(token)),
    clear: () => operation("readwrite", (store) => store.clear()),
    clean: () =>
      operation("readwrite", (store) => {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (cursor.value.entry.expires < Date.now()) cursor.delete();
          cursor.continue();
        };
      }),
  };
})();
