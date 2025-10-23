import { useAuth } from "./state/AuthContext";
import Login from "./pages/Login";
import Caja from "./pages/Caja";
import Cocina from "./pages/Cocina";
import Supervisor from "./pages/Supervisor";
import AdminViandasPage from "./pages/AdminViandas"; // 👈 nuevo import
import { useState } from "react";
import { useRoleGate } from "./hooks/useRoleGate";    // 👈 para saber si es admin

export default function App() {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState<"caja" | "cocina" | "super" | "admin">("caja");
  const { isAdmin } = useRoleGate(); // 👈 detecta si es admin

  if (!user) return <Login />;

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
        </div>

        <button
          className={`tab ${tab === "caja" ? "active" : ""}`}
          onClick={() => setTab("caja")}
        >
          Caja
        </button>
        <button
          className={`tab ${tab === "cocina" ? "active" : ""}`}
          onClick={() => setTab("cocina")}
        >
          Cocina
        </button>
        <button
          className={`tab ${tab === "super" ? "active" : ""}`}
          onClick={() => setTab("super")}
        >
          Supervisor
        </button>

        {isAdmin && ( // 👈 Solo visible para admin
          <button
            className={`tab ${tab === "admin" ? "active" : ""}`}
            onClick={() => setTab("admin")}
          >
            Admin Viandas
          </button>
        )}

        <div className="fill" />
        <span className="badge">{user.email}</span>
        <button className="button ghost" onClick={logout}>
          Salir
        </button>
      </div>

      <div style={{ padding: 16 }}>
        {tab === "caja" && <Caja />}
        {tab === "cocina" && <Cocina />}
        {tab === "super" && <Supervisor />}
        {tab === "admin" && isAdmin && <AdminViandasPage />} {/* 👈 renderiza el panel */}
      </div>
    </div>
  );
}
