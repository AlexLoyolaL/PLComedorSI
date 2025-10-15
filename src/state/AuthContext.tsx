import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import type { User } from "firebase/auth";

import React, { createContext, useContext, useEffect, useState } from "react";
import { auth, provider } from "../firebase";

type Ctx = { user: User | null; loading: boolean; login: () => Promise<void>; logout: () => Promise<void>; };
const AuthCtx = createContext<Ctx>({ user: null, loading: true, login: async () => {}, logout: async () => {} });
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(
      auth,
      (u) => { setUser(u); setLoading(false); },
      (err) => { console.error("onAuthStateChanged error:", err); setLoading(false); }
    );
    return () => unsub();
  }, []);

  const login = async () => { await signInWithPopup(auth, provider); };
  const logout = async () => { await signOut(auth); };

  return <AuthCtx.Provider value={{ user, loading, login, logout }}>{children}</AuthCtx.Provider>;
}
