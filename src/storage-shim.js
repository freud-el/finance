// Bridges the app's `window.storage` API (originally a Claude.ai artifact
// feature) onto two real backends:
// - shared data (accounts, transactions, settings, goals...) goes to a
//   shared Firestore collection, so it syncs between Frédéric and Claire;
// - PDF files (RIB, imported statement originals) stay in the browser's
//   own localStorage, per device — see the Firebase Storage cost decision
//   made earlier (staying on the free plan means these don't sync).
import { db } from "./firebase.js";
import { doc, getDoc, setDoc, deleteDoc } from "firebase/firestore";

const HOUSEHOLD_COLLECTION = "household";

function isFileKey(key) {
  return key.startsWith("file:") || key.startsWith("rib:");
}

// Firestore document IDs can't contain "/" — the app's file/rib keys
// never do, but this guards against surprises either way.
function docRef(key) {
  return doc(db, HOUSEHOLD_COLLECTION, key.replace(/\//g, "_"));
}

window.storage = {
  async get(key) {
    if (isFileKey(key)) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? null : { key, value: raw };
      } catch (err) {
        return null;
      }
    }
    try {
      const snap = await getDoc(docRef(key));
      if (!snap.exists()) return null;
      return { key, value: snap.data().value };
    } catch (err) {
      console.error(`Échec de lecture pour "${key}"`, err);
      return null;
    }
  },
  async set(key, value) {
    if (isFileKey(key)) {
      try {
        localStorage.setItem(key, value);
        return { key, value };
      } catch (err) {
        console.error(`Échec de l'enregistrement local pour "${key}" — le stockage du navigateur est peut-être plein.`, err);
        return null;
      }
    }
    try {
      await setDoc(docRef(key), { value });
      return { key, value };
    } catch (err) {
      console.error(`Échec de l'enregistrement pour "${key}"`, err);
      return null;
    }
  },
  async delete(key) {
    if (isFileKey(key)) {
      try {
        localStorage.removeItem(key);
        return { key, deleted: true };
      } catch (err) {
        return null;
      }
    }
    try {
      await deleteDoc(docRef(key));
      return { key, deleted: true };
    } catch (err) {
      return null;
    }
  },
  async list(prefix) {
    // Only file/rib keys are ever listed by the app today — Firestore-side
    // listing isn't implemented since nothing currently needs it there.
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
