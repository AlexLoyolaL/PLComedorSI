import { useState, useEffect, useRef } from "react";
import { db } from "../firebase";
import { 
  doc, 
  setDoc, 
  collection, 
  onSnapshot, 
  query, 
  deleteDoc,
  serverTimestamp 
} from "firebase/firestore";
import { Card } from "../ui/Card";

type SubsidizedMember = {
  id: string; 
  name: string;
  lastName: string;
  active: boolean;
  createdAt: any;
  expiresAt?: any;           // <-- NUEVO
  totalWithdrawals?: number; // <-- NUEVO
};

export default function Gabinete() {
  const [scanInput, setScanInput] = useState("");
  const [memberId, setMemberId] = useState("");
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [members, setMembers] = useState<SubsidizedMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState({ text: "", type: "" });

  const scanRef = useRef<HTMLInputElement>(null);

  // Escuchar la lista de subvencionados en tiempo real
  useEffect(() => {
    const q = query(collection(db, "subsidized_members"));
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as SubsidizedMember));
      setMembers(list);
    }, (error) => {
      console.error("Error de Firestore:", error);
      setMsg({ text: "Acceso denegado a la base de datos. Avisá a mantenimiento.", type: "error" });
    });
    return () => unsub();
  }, []);

  const handleScan = () => {
    if (!scanInput.trim()) return;
    setMemberId(scanInput.trim());
    setScanInput("");
    setMsg({ text: "Carnet detectado. Completá los datos.", type: "info" });
  };

  const handleSave = async () => {
    if (!memberId || !name || !lastName) {
      setMsg({ text: "Faltan datos obligatorios.", type: "error" });
      return;
    }
    const endOfYear = new Date(new Date().getFullYear(), 11, 31, 23, 59, 59);
    setLoading(true);
    try {
    await setDoc(doc(db, "subsidized_members", memberId), {
      name: name.toUpperCase(),
      lastName: lastName.toUpperCase(),
      active: true,
      createdAt: serverTimestamp(), // "Desde cuando están"
      expiresAt: endOfYear,         // "Vence a fin de año"
      totalWithdrawals: 0,          // Iniciamos el contador
    });
      
      setMsg({ text: "✅ Subvención habilitada con éxito.", type: "success" });
      // Limpiar formulario
      setMemberId("");
      setName("");
      setLastName("");
      scanRef.current?.focus();
    } catch (e: any) {
      setMsg({ text: "Error al guardar: " + e.message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const removeMember = async (id: string) => {
    if (!confirm("¿Seguro que querés quitar el beneficio a esta persona?")) return;
    try {
      await deleteDoc(doc(db, "subsidized_members", id));
    } catch (e: any) {
      alert("Error: " + e.message);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 16 }}>
      
      {/* Columna Izquierda: Alta */}
      <div style={{ display: "grid", gap: 16 }}>
        <Card title="Habilitar Nueva Subvención">
          <div style={{ display: "grid", gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600 }}>1) Escanear Carnet</label>
              <input
                ref={scanRef}
                className="input"
                placeholder="Escaneá el código aquí..."
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleScan()}
              />
            </div>

            {memberId && (
              <div className="panel" style={{ background: "rgba(var(--brand-rgb), 0.05)" }}>
                <p style={{ margin: 0, fontSize: 13 }}>ID Carnet: <b>{memberId}</b></p>
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  <input 
                    className="input" 
                    placeholder="Nombre" 
                    value={name} 
                    onChange={e => setName(e.target.value)} 
                  />
                  <input 
                    className="input" 
                    placeholder="Apellido" 
                    value={lastName} 
                    onChange={e => setLastName(e.target.value)} 
                  />
                  <button 
                    className="button" 
                    disabled={loading} 
                    onClick={handleSave}
                  >
                    {loading ? "Guardando..." : "Confirmar Subvención"}
                  </button>
                </div>
              </div>
            )}

            {msg.text && (
              <div style={{ 
                padding: 10, borderRadius: 6, fontSize: 13,
                background: msg.type === "error" ? "var(--danger-bg)" : "var(--brand-bg)",
                color: msg.type === "error" ? "var(--danger)" : "var(--brand)"
              }}>
                {msg.text}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Columna Derecha: Listado */}
      <Card title="Padrón de Subvencionados">
        <div style={{ maxHeight: "70vh", overflow: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Socio</th>
                <th>Desde</th>
                <th>Vence</th>
                <th>Retiros</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {members.map(m => (
                <tr key={m.id}>
                  <td><b>{m.lastName}, {m.name}</b></td>
                  {/* Mostramos fecha de alta */}
                  <td>{m.createdAt?.toDate ? m.createdAt.toDate().toLocaleDateString() : '-'}</td>
                  {/* Mostramos vencimiento */}
                  <td>{m.expiresAt?.toDate ? m.expiresAt.toDate().toLocaleDateString() : '31/12'}</td>
                  {/* Mostramos el contador acumulado */}
                  <td style={{ textAlign: 'center' }}>
                    <span className="badge" style={{ background: 'var(--brand)', color: '#fff' }}>
                      {m.totalWithdrawals || 0}
                    </span>
                  </td>
                  <td>
                    <button className="button ghost" onClick={() => removeMember(m.id)}>Quitar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}