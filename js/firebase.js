// Shared Firebase setup for GT Sidequests.
// The config below identifies the project. It is not a secret: access is enforced by firestore.rules.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export * from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
export * from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyBohnwY4iPzOaLsLL2GwtS9IWjGs5ExvRQ",
  authDomain: "gt-sidequests.firebaseapp.com",
  projectId: "gt-sidequests",
  storageBucket: "gt-sidequests.firebasestorage.app",
  messagingSenderId: "1002935005850",
  appId: "1:1002935005850:web:24e1e66adf77bd74c7a523",
};

// The only Google account allowed into host.html. Must match firestore.rules.
export const HOST_EMAIL = "ejimahshalom@gmail.com";

const useEmulator = ["localhost", "127.0.0.1"].includes(location.hostname) && new URLSearchParams(location.search).has("emu");

// Player and host use separately named apps so their sign-ins never overwrite each other
// (you can be a player and the host on the same phone).
export function makeApp(name, { offline = true } = {}) {
  const app = initializeApp(firebaseConfig, name);
  const auth = getAuth(app);
  const db = offline
    ? initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })
    : initializeFirestore(app, {});
  if (useEmulator) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }
  return { app, auth, db };
}
