import { useAuth } from "../state/AuthContext";

function GoogleIcon(){
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" style={{marginRight:8}}>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.8 32.5 29.3 36 24 36 16.8 36 11 30.2 11 23s5.8-13 13-13c3.1 0 5.9 1.1 8.1 3.1l5.7-5.7C34.5 4.6 29.5 2.5 24 2.5 12 2.5 2.5 12 2.5 24S12 45.5 24 45.5c12 0 21.5-9.5 21.5-21.5 0-1.5-.2-3-.5-4.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.4 16 18.8 13 24 13c3.1 0 5.9 1.1 8.1 3.1l5.7-5.7C34.5 4.6 29.5 2.5 24 2.5 15.4 2.5 8.1 7.3 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 45.5c5.2 0 10-2 13.5-5.3L32.1 34C30 35.6 27.2 36.5 24 36 18.8 36 14.4 33 12.9 29.4l-6.6 4.8C8.1 40.7 15.4 45.5 24 45.5z"/>
      <path fill="#1976D2" d="M45.5 24c0-1.5-.2-3-.5-4.5H24v8h11.3c-1 2.9-3.4 5.1-6.2 6.5l5.5 6.2C38.9 37.1 45.5 31.3 45.5 24z"/>
    </svg>
  );
}

export default function Login(){
  const { login } = useAuth();

  return (
    <div className="center">
      <div className="card">
        <h1>Puerto Libre — Acceso</h1>
        <p>Ingresá con tu cuenta de Google para registrar ventas y ver los tableros.</p>
        <button className="button" onClick={login} style={{display:"inline-flex", alignItems:"center"}}>
          <GoogleIcon/> Ingresar con Google
        </button>
        <div style={{marginTop:16, color:"var(--muted)", fontSize:12}}>
          Dominio <b>localhost</b> debe estar autorizado en Firebase ▸ Authentication ▸ Settings.
        </div>
      </div>
    </div>
  );
}
