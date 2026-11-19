import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import type { User } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import React, { createContext, useContext, useEffect, useState } from "react";
import { auth, provider, db } from "../firebase"; 
import { CENTER_IDS, isCenterId } from "../lib/centers";
import type { CenterId } from "../lib/centers";

type Ctx = { 
  user: User | null; 
  role: string | null; 
  allowedCenters: CenterId[];
  loading: boolean; 
  login: () => Promise<void>; 
  logout: () => Promise<void>; 
};

const AuthCtx = createContext<Ctx>({ 
  user: null, 
  role: null, 
  allowedCenters: [],
  loading: true, 
  login: async () => {}, 
  logout: async () => {} 
});

export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<string | null>(null); 
  const [allowedCenters, setAllowedCenters] = useState<CenterId[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(
      auth,
      async (u) => { 
        setUser(u); 
        
        if (u) {

          try {
            await setDoc(doc(db, "users", u.uid), {
              uid: u.uid,
              email: u.email?.toLowerCase(),
              name: u.displayName || "",
              lastLogin: new Date()
            }, { merge: true });
          } catch (e) {
            console.error("Error guardando perfil de usuario:", e);
          }

          try {
            const rolesRef = doc(db, "app", "roles");
            const rolesSnap = await getDoc(rolesRef);
            
            if (rolesSnap.exists()) {
              const rolesData = rolesSnap.data();
              const uid = u.uid;
              const grantGlobalAccess = (nextRole: string) => {
                setRole(nextRole);
                setAllowedCenters([...CENTER_IDS]);
              };
              
              // Verificamos en qué lista está el UID del usuario (Desacoplado)
              if (rolesData.root?.[uid]) grantGlobalAccess("root");
              else if (rolesData.administradores?.[uid]) grantGlobalAccess("administrador");
              else if (rolesData.administrativos?.[uid]) grantGlobalAccess("administrativo");
              else if (rolesData.cocina?.[uid]) grantGlobalAccess("cocina");
              else if (rolesData.directores?.[uid]) grantGlobalAccess("visor");
              else if (rolesData.gabinete?.[uid]) grantGlobalAccess("gabinete");
              else if (rolesData.cobradores?.[uid]) {
                const configuredCenters = Array.isArray(rolesData.cobradores[uid]?.centers)
                  ? rolesData.cobradores[uid].centers.filter(isCenterId)
                  : [];
                setRole(configuredCenters.length ? "cobrador" : "unauthorized");
                setAllowedCenters(configuredCenters);
              } else {
                setRole("unauthorized");
                setAllowedCenters([]);
              }
            } else {
              setRole("unauthorized"); 
              setAllowedCenters([]);
            }
          } catch (err) {
            console.error("Error al buscar el rol:", err);
            setRole("unauthorized"); 
          }
        } else {
          setRole(null);
          setAllowedCenters([]);
        }
        
        setLoading(false); 
      },
      (err) => { 
        console.error("onAuthStateChanged error:", err); 
        setLoading(false); 
      }
    );
    return () => unsub();
  }, []);

  const login = async () => { await signInWithPopup(auth, provider); };
  const logout = async () => { await signOut(auth); };

  return <AuthCtx.Provider value={{ user, role, allowedCenters, loading, login, logout }}>{children}</AuthCtx.Provider>;
}
