import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../state/AuthContext"; // usa tu contexto de autenticación

type RolesDoc = {
  admins?: Record<string, boolean>;
  supervisors?: Record<string, boolean>;
  administrativos?: Record<string, boolean>;
  cocina?: Record<string, boolean>;
};

// Hook que escucha el documento app/roles y devuelve los permisos del usuario actual
export function useRoleGate() {
  const { user } = useAuth(); // debe venir de tu AuthContext (user.uid, user.email, etc.)
  const [roles, setRoles] = useState<RolesDoc | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "app", "roles"), (snap) => {
      if (snap.exists()) setRoles(snap.data() as RolesDoc);
      else setRoles({}); // si no existe el doc, no hay roles aún
    });
    return () => unsub();
  }, []);

  const uid = user?.uid ?? "";

  const isAdmin = !!roles?.admins?.[uid];
  const isSupervisor = !!roles?.supervisors?.[uid] || isAdmin;
  const isAdministrativo = !!roles?.administrativos?.[uid] || isAdmin;
  const isCocina = !!roles?.cocina?.[uid] || isAdmin;

  return {
    loading: roles === null,
    isAdmin,
    isSupervisor,
    isAdministrativo,
    isCocina,
  };
}
