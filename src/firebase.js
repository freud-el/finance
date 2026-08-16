import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// This config is not a secret — Firebase's client-side keys are meant to
// be public. Real access control comes from the Firestore security rules
// (restricting reads/writes to frederic@lannez.me and claire@lannez.me)
// and from Firebase Auth requiring a valid login, not from hiding this.
const firebaseConfig = {
  apiKey: "AIzaSyBlI2t9LKnncCgLdzSWMCoWaBJedmmuB_s",
  authDomain: "finance-1b2df.firebaseapp.com",
  projectId: "finance-1b2df",
  storageBucket: "finance-1b2df.firebasestorage.app",
  messagingSenderId: "384874117547",
  appId: "1:384874117547:web:3b96b45b7a9711b6a83aee",
  measurementId: "G-01NEE3GQ9G",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
