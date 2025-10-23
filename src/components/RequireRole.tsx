// src/components/RequireRole.tsx
import type { ReactNode } from "react";              // ← type-only import
import { useRoleGate } from "../hooks/useRoleGate";  // ruta correcta: components -> hooks

type Role = "admin" | "supervisor" | "administrativo" | "cocina";

type Props = {
  allowAny: Role[];       // puede recibir varios roles permitidos
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
  const { loading, isAdmin, isSupervisor, isAdministrativo, isCocina } = useRoleGate();

  if (loading) {
    return <div style={{ color: "var(--muted)" }}>Cargando permisos…</div>;
  }

  const have: Record<Role, boolean> = {
    admin: isAdmin,
    supervisor: isSupervisor,
    administrativo: isAdministrativo,
    cocina: isCocina,
  };

  const ok = allowAny.some((r) => have[r]);

  return ok ? <>{children}</> : <>{fallback}</>;
}

export default RequireRole;
