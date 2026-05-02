// src/components/Unauthorized.tsx
import { useAuth } from "../state/AuthContext";

export default function Unauthorized() {
  // Ahora usamos la función 'logout' que armamos en tu AuthContext
  const { logout } = useAuth(); 

  return (
    <div style={{ 
      display: 'flex', flexDirection: 'column', alignItems: 'center', 
      justifyContent: 'center', height: '100vh', textAlign: 'center', padding: 20 
    }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>⛔</div>
      <h1 style={{ color: 'var(--danger)', marginBottom: 8 }}>Acceso Denegado</h1>
      <p style={{ color: 'var(--muted)', maxWidth: 400, marginBottom: 24 }}>
        Tu cuenta de Google está validada, pero no tenés ningún rol asignado en el sistema de Puerto Libre.
        <br /><br />
        Si sos personal del predio, por favor contactá a <b>Alex Loyola (Administrador)</b> para que te habilite el acceso.
      </p>
      <button 
        className="button outline"
        onClick={logout} 
      >
        Cerrar sesión
      </button>
    </div>
  );
}