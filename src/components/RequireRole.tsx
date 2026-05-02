// src/components/RequireRole.tsx
import type { ReactNode } from "react";
import { useAuth } from "../state/AuthContext"; // Conectamos directo a la fuente de verdad

// Actualizamos los tipos estrictos a la nueva arquitectura RBAC
type Role = "root" | "administrador" | "administrativo" | "cocina" | "visor" | "gabinete";

type Props = {
  allowAny: Role[];
  children: ReactNode;
  fallback?: ReactNode;
};

export function RequireRole({
  allowAny,
  children,
  fallback = (
    <div className="panel" style={{ borderColor: "var(--danger)" }}>
      No tenés permisos para ver esta sección.
    </div>
  ),
}: Props) {
  // Extraemos directamente el rol del estado global
  const { role, loading } = useAuth();

  if (loading) {
    return <div style={{ color: "var(--muted)" }}>Cargando permisos…</div>;
  }

  // 1. ROOT bypass: Si el usuario es root, pasa automáticamente (God Mode)
  const isRoot = role === "root";

  // 2. Validación estándar: Verificamos si el string del rol actual está en el array permitido
  const isAllowed = role && allowAny.includes(role as Role);

  return (isRoot || isAllowed) ? <>{children}</> : <>{fallback}</>;
}

export default RequireRole;