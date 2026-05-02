import { useAuth } from "./state/AuthContext";
import Login from "./pages/Login";
import Caja from "./pages/Caja";
import Cocina from "./pages/Cocina";
import Supervisor from "./pages/Supervisor";
import AdminViandasPage from "./pages/AdminViandas";
import RendicionPage from "./pages/Rendicion";
import { useState, useEffect } from "react";
import Gabinete from "./pages/Gabinete";

type Tab = "caja" | "cocina" | "super" | "admin" | "rendicion" | "gabinete";

export default function App() {
  const { user, role, loading, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("caja");

  // Redirección inteligente al iniciar sesión
  useEffect(() => {
    if (role === "cocina") {
      setTab("cocina");
    } else if (role === "gabinete") {
      // Si el rol es estricto de gabinete, aterriza directo acá
      setTab("gabinete");
    } else if (role === "visor" || role === "directores") {
      setTab("super"); 
    } else {
      setTab("caja");
    }
  }, [role]);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
        <h2>Cargando sistema...</h2>
      </div>
    );
  }

  if (!user) return <Login />;

  if (role === "unauthorized") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", textAlign: "center", padding: 20 }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>⛔</div>
        <h1 style={{ color: "var(--danger)", marginBottom: 8 }}>Acceso Denegado</h1>
        <p style={{ color: "var(--muted)", maxWidth: 400, marginBottom: 24 }}>
          La cuenta <b>{user.email}</b> no tiene permisos asignados en Puerto Libre.
          <br /><br />
          Contactá a <b>Alex Loyola</b> para que te habilite el acceso.
        </p>
        <button className="button outline" onClick={logout}>Cerrar sesión</button>
      </div>
    );
  }

  // ==========================================
  // COMPUERTAS LÓGICAS DE ROLES (SoD ESTRICTO)
  // ==========================================
  const isRoot = role === "root";
  const isAdmin = role === "administrador";
  const isVisor = role === "visor" || role === "directores"; // Directores/Auditores
  const isAdministrativo = role === "administrativo";
  const isCocina = role === "cocina";
  
  // NUEVO: Extraemos Gabinete en su propia variable aislada
  const isGabinete = role === "gabinete"; 

  // 1. CAJA: Root, Admin, Cajeros y Visores (Gabinete NO)
  const canSeeCaja = isRoot || isAdmin || isAdministrativo || isVisor;
  
  // 2. COCINA: Root, Admin, Cajeros, Cocina y Visores (Gabinete NO)
  const canSeeCocina = isRoot || isAdmin || isAdministrativo || isCocina || isVisor;
  
  // 3. SUPERVISOR: Root, Admin y Visores (Gabinete NO)
  const canSeeSuper = isRoot || isAdmin || isVisor;
  
  // 4. GABINETE SOCIAL: EXCLUSIVO para Root y Gabinete
  const canSeeGabinete = isRoot || isGabinete; 
  
  // 5. ADMIN VIANDAS: Solo Root y Administradores (Gabinete NO)
  const canSeeAdminViandas = isRoot || isAdmin;
  
  // 6. RENDICIÓN: Root, Admin, Cajeros y Visores (Gabinete NO)
  const canSeeRendicion = isRoot || isAdmin || isAdministrativo || isVisor;

  return (
    <div style={{ minHeight: "100%" }}>
      <div className="appbar">
        <div className="brand">
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: "var(--brand)",
            }}
          />
          Puerto Libre
          <span style={{ fontSize: 10, background: 'rgba(255,255,255,0.2)', padding: '2px 6px', borderRadius: 4, marginLeft: 8 }}>
            {role?.toUpperCase()}
          </span>
        </div>

        {canSeeCaja && (
          <button className={`tab ${tab === "caja" ? "active" : ""}`} onClick={() => setTab("caja")}>
            Caja
          </button>
        )}

        {canSeeCocina && (
          <button className={`tab ${tab === "cocina" ? "active" : ""}`} onClick={() => setTab("cocina")}>
            Cocina
          </button>
        )}

        {canSeeSuper && (
          <button className={`tab ${tab === "super" ? "active" : ""}`} onClick={() => setTab("super")}>
            Supervisor
          </button>
        )}
        
        {canSeeGabinete && (
          <button className={`tab ${tab === "gabinete" ? "active" : ""}`} onClick={() => setTab("gabinete")}>
            Gabinete Social
          </button>
        )}

        {canSeeAdminViandas && (
          <button className={`tab ${tab === "admin" ? "active" : ""}`} onClick={() => setTab("admin")}>
            Admin Viandas
          </button>
        )}

        {canSeeRendicion && (
          <button className={`tab ${tab === "rendicion" ? "active" : ""}`} onClick={() => setTab("rendicion")}>
            Rendición
          </button>
        )}

        <div className="fill" />
        <span className="badge">{user.email}</span>
        <button className="button ghost" onClick={logout}>
          Salir
        </button>
      </div>

      <div style={{ padding: 16 }}>
        {tab === "caja" && canSeeCaja && <Caja />}
        {tab === "cocina" && canSeeCocina && <Cocina />}
        {tab === "super" && canSeeSuper && <Supervisor />}
        {tab === "gabinete" && canSeeGabinete && <Gabinete />}
        {tab === "admin" && canSeeAdminViandas && <AdminViandasPage />}
        {tab === "rendicion" && canSeeRendicion && <RendicionPage />}
      </div>
    </div>
  );
}