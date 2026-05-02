import Supervisor from "./Supervisor";
import { RequireRole } from "../components/RequireRole";
export default function SupervisorPage() {
  return (
    <RequireRole allowAny={["visor", "administrativo"]}>
      <Supervisor />
    </RequireRole>
  );
}