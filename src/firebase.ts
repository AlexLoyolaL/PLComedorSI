import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
// NUEVO: Importamos las herramientas para el modo offline
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
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
assertEnv("VITE_FIREBASE_APP_ID", cfg.appId);

export const app = initializeApp(cfg);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();

// NUEVO: Reemplazamos getFirestore() por la inicialización con soporte Offline
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    // Permite que si tienen varias pestañas abiertas, compartan la base de datos offline
    tabManager: persistentMultipleTabManager() 
  })
});