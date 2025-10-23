// src/pages/CocinaPage.tsx
import Cocina from "./Cocina";
import { RequireRole } from "../components/RequireRole";
export default function CocinaPage() {
  return (
    <RequireRole allowAny={["cocina", "administrativo", "admin"]}>
      <Cocina />
    </RequireRole>
  );
}
