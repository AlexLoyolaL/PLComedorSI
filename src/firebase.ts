import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getStorage } from "firebase/storage";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET, // <-- NUEVO
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

function assertEnv(name: string, value: any) {
  if (!value) {
    const msg = `[Firebase ENV] Falta ${name}. Revisá tu .env (recordá el prefijo VITE_) y reiniciá "npm run dev".`;
    console.error(msg);
    throw new Error(msg);
  }
}

assertEnv("VITE_FIREBASE_API_KEY", cfg.apiKey);
assertEnv("VITE_FIREBASE_AUTH_DOMAIN", cfg.authDomain);
assertEnv("VITE_FIREBASE_PROJECT_ID", cfg.projectId);
assertEnv("VITE_FIREBASE_STORAGE_BUCKET", cfg.storageBucket); // <-- NUEVA VALIDACIÓN
assertEnv("VITE_FIREBASE_APP_ID", cfg.appId);

export const app = initializeApp(cfg);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager() 
  })
});
export const storage = getStorage(app);