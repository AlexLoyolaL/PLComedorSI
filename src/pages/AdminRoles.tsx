import { useState } from "react";
import { collection, query, where, getDocs, doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Card } from "../ui/Card";
import RequireRole from "../components/RequireRole";
import { CENTER_IDS, CENTER_LABELS } from "../lib/centers";
import type { CenterId } from "../lib/centers";


type RoleType = "root" | "administrador" | "administrativo" | "cobrador" | "cocina" | "visor" | "gabinete" | "remover";

// Nombres exactos de los nodos en tu base de datos Firestore (app/roles)
const ALL_ROLES = ["root", "administradores", "administrativos", "cobradores", "cocina", "directores", "gabinete"];

export default function AdminRolesPage() {
  return (
    <RequireRole allowAny={["root"]}>
      <AdminRolesInner />
    </RequireRole>
  );
}

function AdminRolesInner() {
  const [email, setEmail] = useState("");
  const [targetRole, setTargetRole] = useState<RoleType>("administrativo");
  const [selectedCenters, setSelectedCenters] = useState<CenterId[]>(["PUERTO_LIBRE"]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState({ text: "", type: "" });

  async function handleAssign() {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes("@")) {
      setMsg({ text: "Ingresá un correo válido.", type: "error" });
      return;
    }
    if (targetRole === "cobrador" && selectedCenters.length === 0) {
      setMsg({ text: "Seleccioná al menos una sede para el perfil de Cuotas y Servicios.", type: "error" });
      return;
    }

    setLoading(true);
    setMsg({ text: "Buscando UID en el sistema...", type: "info" });

    try {
      // 1. ETL: Buscamos el UID a partir del Email
      const q = query(collection(db, "users"), where("email", "==", cleanEmail));
      const snap = await getDocs(q);

      if (snap.empty) {
        setMsg({ 
          text: `No se encontró a ${cleanEmail}. Pedile que intente iniciar sesión en la app (aunque le tire error) para que el sistema lo registre.`, 
          type: "error" 
        });
        setLoading(false);
        return;
      }

      // Extraemos el UID inmutable
      const targetUid = snap.docs[0].id; 

      // 2. Traemos el documento maestro de roles
      const rolesRef = doc(db, "app", "roles");
      const rolesSnap = await getDoc(rolesRef);
      
      const rolesData = rolesSnap.exists() ? rolesSnap.data() : {};

      // 3. SoD Estricto: Limpiamos al usuario de TODOS los roles existentes
      ALL_ROLES.forEach(rol => {
        if (rolesData[rol] && rolesData[rol][targetUid]) {
          delete rolesData[rol][targetUid];
        }
      });

      // 4. Asignación: Le damos el rol nuevo con el formato { uid: true }
      if (targetRole !== "remover") {
        let dbNode = targetRole as string;
        // Traducción de frontend a la nomenclatura de tu BD
        if (targetRole === "visor") dbNode = "directores";
        if (targetRole === "administrativo") dbNode = "administrativos";
        if (targetRole === "administrador") dbNode = "administradores";

        // Si el nodo no existe, lo creamos
        if (!rolesData[dbNode]) rolesData[dbNode] = {};
        
        // Cobros usa un permiso acotado por sede; los demás roles siguen siendo globales.
        rolesData[dbNode][targetUid] = targetRole === "cobrador"
          ? { centers: selectedCenters }
          : true;
      }

      // 5. Impactamos la base de datos
      await setDoc(rolesRef, rolesData);

      setMsg({ 
        text: targetRole === "remover" 
          ? `Acceso removido completamente para ${cleanEmail}` 
          : targetRole === "cobrador"
            ? `Acceso a Cuotas y Servicios asignado para: ${selectedCenters.map((centerId) => CENTER_LABELS[centerId]).join(", ")}. Ya puede recargar la página.`
            : `Rol '${targetRole}' asignado. Ya pueden recargar la página y entrar.`,
        type: "success" 
      });
      setEmail("");

    } catch (error: unknown) {
      console.error(error);
      setMsg({ text: "Error de transacción: " + (error instanceof Error ? error.message : String(error)), type: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid cols-1" style={{ maxWidth: 600, margin: "0 auto" }}>
      <Card title="Gestión de Permisos (God Mode)">
        
        <div className="panel" style={{ background: "rgba(59, 130, 246, 0.1)", borderColor: "#3b82f6", marginBottom: 16 }}>
          <div style={{ fontWeight: "bold", color: "#3b82f6", marginBottom: 4 }}>📌 Procedimiento de Alta Segura</div>
          <ol style={{ margin: 0, paddingLeft: 16, fontSize: 13, color: "var(--muted)" }}>
            <li>Pedile al nuevo operador que ingrese a la app con su cuenta de Google.</li>
            <li>Le va a aparecer la pantalla roja de "Acceso Denegado".</li>
            <li>En ese momento el sistema ya registró su UID de forma segura.</li>
            <li>Ingresá su correo acá abajo y asignale el nivel de acceso.</li>
          </ol>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={{ display: "block", marginBottom: 6, fontWeight: "bold" }}>Correo Registrado (Gmail)</label>
            <input
              type="email"
              className="input"
              placeholder="ejemplo@gmail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              style={{ width: "100%" }}
            />
          </div>

          <div>
            <label style={{ display: "block", marginBottom: 6, fontWeight: "bold" }}>Nivel de Acceso Funcional</label>
            <select
              className="input"
              value={targetRole}
              onChange={(e) => setTargetRole(e.target.value as RoleType)}
              disabled={loading}
              style={{ width: "100%" }}
            >
              <option value="administrativo">Administrativo (Caja y Rendición)</option>
              <option value="cobrador">Cuotas y Servicios por sede (incluye rendición)</option>
              <option value="administrador">Administrador (Gestión de stock manual)</option>
              <option value="cocina">Cocina (Solo lectura monitor)</option>
              <option value="gabinete">Gabinete Social (Gestión de padrón)</option>
              <option value="visor">Directores / Auditoría (Solo lectura global)</option>
              <option value="root">ROOT (Acceso Total)</option>
              <option value="remover" style={{ color: "red", fontWeight: "bold" }}>⛔ REVOCAR TODOS LOS ACCESOS</option>
            </select>
          </div>

          {targetRole === "cobrador" && (
            <div className="access-centers-panel">
              <div className="access-centers-heading">
                <div><strong>Sedes habilitadas</strong><span>Puede seleccionar una, varias o todas.</span></div>
                <button type="button" className="button outline" onClick={() => setSelectedCenters(
                  selectedCenters.length === CENTER_IDS.length ? [] : [...CENTER_IDS]
                )}>{selectedCenters.length === CENTER_IDS.length ? "Quitar todas" : "Seleccionar todas"}</button>
              </div>
              <div className="access-centers-options">
                {CENTER_IDS.map((centerId) => <label key={centerId} className={selectedCenters.includes(centerId) ? "active" : ""}>
                  <input
                    type="checkbox"
                    checked={selectedCenters.includes(centerId)}
                    onChange={() => setSelectedCenters((current) => current.includes(centerId)
                      ? current.filter((item) => item !== centerId)
                      : [...current, centerId]
                    )}
                  />
                  <span>{CENTER_LABELS[centerId]}</span>
                </label>)}
              </div>
            </div>
          )}

          <button 
            className="button" 
            onClick={handleAssign} 
            disabled={loading}
            style={{ 
              background: targetRole === "remover" ? "var(--danger)" : "var(--brand)",
              marginTop: 8 
            }}
          >
            {loading ? "Calculando Hash UID..." : (targetRole === "remover" ? "Eliminar Permisos" : "Ejecutar Asignación")}
          </button>

          {msg.text && (
            <div className="panel" style={{ 
              borderColor: msg.type === "success" ? "var(--ok)" : (msg.type === "error" ? "var(--danger)" : "var(--brand)"),
              marginTop: 8
            }}>
              {msg.text}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
