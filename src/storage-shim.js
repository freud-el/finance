// Temporary stand-in for the Claude.ai-artifact-specific `window.storage`
// API, using the browser's own localStorage. This lets the app run as a
// normal website — but localStorage is per-browser (no sync between
// devices) and has a small size limit (a handful of MB), which matters
// once RIB PDFs and imported statement files pile up. This is meant to be
// replaced by Firebase Firestore (+ Storage for the files) in a later
// step — this file exists purely to validate that the rest of the app
// works correctly outside the Claude.ai sandbox first.
window.storage = {
  async get(key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      return { key, value: raw };
    } catch (err) {
      return null;
    }
  },
  async set(key, value) {
    try {
      localStorage.setItem(key, value);
      return { key, value };
    } catch (err) {
      // Most likely the 5-10MB localStorage quota was exceeded (large PDF
      // imports add up fast) — surface this clearly instead of silently
      // losing data.
      console.error(`Échec de l'enregistrement pour "${key}" — le stockage du navigateur est peut-être plein.`, err);
      return null;
    }
  },
  async delete(key) {
    try {
      localStorage.removeItem(key);
      return { key, deleted: true };
    } catch (err) {
      return null;
    }
  },
  async list(prefix) {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!prefix || (k && k.startsWith(prefix))) keys.push(k);
      }
      return { keys, prefix };
    } catch (err) {
      return null;
    }
  },
};
