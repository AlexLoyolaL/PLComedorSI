import Supervisor from "./Supervisor";
import { RequireRole } from "../components/RequireRole";
export default function SupervisorPage() {
  return (
    <RequireRole allowAny={["supervisor", "administrativo"]}>
      <Supervisor />
    </RequireRole>
  );
}