// src/pages/CajaPage.tsx
import Caja from "./Caja";
import { RequireRole } from "../components/RequireRole";
export default function CajaPage() {
  return (
    <RequireRole allowAny={["administrador", "administrativo", "visor"]}>
      <Caja />
    </RequireRole>
  );
}
