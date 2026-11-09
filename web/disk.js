"use strict";

async function openNexaDisk(loadSeed, signal) {
  if (!navigator.locks || !globalThis.indexedDB) {
    throw new Error("Для постоянного диска нужны IndexedDB и Web Locks. Откройте NexaOS через localhost или HTTPS.");
  }

  const release = await new Promise((resolve, reject) => {
    navigator.locks.request("nexaos-data-ext4", { ifAvailable: true }, lock => {
      if (!lock) {
        reject(new Error("Постоянный диск занят в другой вкладке NexaOS."));
        return;
      }
      return new Promise(unlock => resolve(unlock));
    }).catch(reject);
  });

  let db;
  try {
    signal.throwIfAborted();
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("nexaos-storage", 1);
      let cancelled = false;
      const failOpen = error => {
        cancelled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      };
      const abort = () => failOpen(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      request.onupgradeneeded = () => {
        if (cancelled) request.transaction.abort();
        else request.result.createObjectStore("disks");
      };
      request.onblocked = () => failOpen(new Error("Обновление хранилища диска заблокировано другой вкладкой."));
      request.onerror = () => failOpen(request.error);
      request.onsuccess = () => {
        signal.removeEventListener("abort", abort);
        if (cancelled) request.result.close();
        else resolve(request.result);
      };
    });
    signal.throwIfAborted();
    const saved = await new Promise((resolve, reject) => {
      const request = db.transaction("disks").objectStore("disks").get("home-ext4");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const buffer = saved === undefined ? await loadSeed() : saved;
    signal.throwIfAborted();
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== 64 * 1024 * 1024 ||
        new DataView(buffer).getUint16(1080, true) !== 0xef53) {
      throw new Error("Некорректный образ постоянного диска NexaOS.");
    }

    return {
      buffer,
      restored: saved !== undefined,
      save() {
        return new Promise((resolve, reject) => {
          const transaction = db.transaction("disks", "readwrite", { durability: "strict" });
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error || new Error("Транзакция сохранения диска отменена."));
          transaction.objectStore("disks").put(buffer, "home-ext4");
        });
      },
      close() {
        db.close();
        release();
      },
    };
  } catch (error) {
    db?.close();
    release();
    throw error;
  }
}
