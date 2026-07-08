import { useState, useEffect, useRef, useMemo } from "react";
import { db } from "../firebase";
import {
  doc,
  setDoc,
  collection,
  onSnapshot,
  query,
  deleteDoc,
  getDoc,
  serverTimestamp,
  documentId,
  getDocs,
  where,
} from "firebase/firestore";
import { Card } from "../ui/Card";
import { resolveMemberDni } from "../lib/memberId";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

const PURE_DNI_RE = /^\d{7,9}$/;

type SubsidizedMember = {
  id: string; 
  name: string;
  lastName: string;
  active: boolean;
  createdAt: any;
  expiresAt?: any;           // <-- NUEVO
  totalWithdrawals?: number; // <-- NUEVO
};

function addDays(date: Date, delta: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + delta);
  return d;
}

function toDateInputValue(date: Date) {
  const z = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

export default function Gabinete() {
  const [activeTab, setActiveTab] = useState<"alta" | "analisis">("alta");

  const [scanInput, setScanInput] = useState("");
  const [manualDni, setManualDni] = useState("");
  const [memberId, setMemberId] = useState("");
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [members, setMembers] = useState<SubsidizedMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState({ text: "", type: "" });

  // --- Datos para la pestaña de Análisis ---
  const [trendDays, setTrendDays] = useState(30);
  const [trendData, setTrendData] = useState<{ date: string; subvencionados: number }[]>([]);
  const [trendLoading, setTrendLoading] = useState(false);

  // --- Reparación de carnets viejos (guardados con el código crudo en vez del DNI) ---
  const [migrating, setMigrating] = useState(false);
  const [migrationLog, setMigrationLog] = useState<string[]>([]);

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

  // Traer la tendencia diaria de subvencionados (dayAgg.financial.subsidized)
  useEffect(() => {
    if (activeTab !== "analisis") return;

    let active = true;
    setTrendLoading(true);

    const end = new Date();
    const start = addDays(end, -(trendDays - 1));
    const startKey = toDateInputValue(start);
    const endKey = toDateInputValue(end);

    const qAgg = query(
      collection(db, "dayAgg"),
      where(documentId(), ">=", startKey),
      where(documentId(), "<=", endKey)
    );

    getDocs(qAgg)
      .then((snap) => {
        if (!active) return;
        const byDate = new Map<string, number>();
        snap.forEach((d) => {
          const data = d.data() as any;
          byDate.set(d.id, data.financial?.subsidized ?? 0);
        });

        const out: { date: string; subvencionados: number }[] = [];
        for (let i = 0; i < trendDays; i++) {
          const dKey = toDateInputValue(addDays(start, i));
          out.push({ date: dKey.slice(5), subvencionados: byDate.get(dKey) ?? 0 });
        }
        setTrendData(out);
      })
      .catch((e) => {
        console.error("Error cargando tendencia de subvencionados:", e);
      })
      .finally(() => {
        if (active) setTrendLoading(false);
      });

    return () => { active = false; };
  }, [activeTab, trendDays]);

  // --- KPIs y listados calculados sobre el padrón ---
  const analytics = useMemo(() => {
    const now = new Date();
    const in30Days = addDays(now, 30);

    const activos = members.filter((m) => m.active);
    const totalRetiros = members.reduce((acc, m) => acc + (m.totalWithdrawals || 0), 0);

    const vencidos = activos.filter((m) => {
      const exp = m.expiresAt?.toDate ? m.expiresAt.toDate() : null;
      return exp && exp < now;
    });

    const porVencer = activos.filter((m) => {
      const exp = m.expiresAt?.toDate ? m.expiresAt.toDate() : null;
      return exp && exp >= now && exp <= in30Days;
    });

    const sinUso = activos.filter((m) => !m.totalWithdrawals);

    const ranking = [...activos]
      .sort((a, b) => (b.totalWithdrawals || 0) - (a.totalWithdrawals || 0))
      .slice(0, 10);

    return {
      totalActivos: activos.length,
      totalRetiros,
      promedioPorSocio: activos.length ? totalRetiros / activos.length : 0,
      vencidos,
      porVencer,
      sinUso,
      ranking,
    };
  }, [members]);

  // Carnets viejos: el "id" del documento no es un DNI puro, sino el texto
  // crudo que se escaneó en su momento (a veces con nombre, teléfono, etc.
  // adelante). Detectamos el DNI como los primeros 7 a 9 dígitos del código.
  const brokenMembers = useMemo(
    () => members.filter((m) => !PURE_DNI_RE.test(m.id)),
    [members]
  );

  const handleScan = async () => {
    if (!scanInput.trim()) return;
    const raw = scanInput;
    setScanInput("");

    try {
      // Usamos la MISMA resolución que Caja (vía qr_mappings) para que el
      // socio quede guardado bajo el mismo DNI con el que después se lo
      // busca al cobrar. Si acá se guardara con una clave distinta a la
      // que usa Caja, el sistema nunca reconocería al socio como
      // subvencionado aunque esté cargado.
      const dni = await resolveMemberDni(raw);
      if (!dni) {
        setMsg({ text: "❌ Vinculación cancelada o DNI inválido. Volvé a escanear.", type: "error" });
        return;
      }
      setMemberId(dni);
      setMsg({ text: "Carnet detectado. Completá los datos.", type: "info" });
    } catch (e: any) {
      setMsg({ text: "Error leyendo el carnet: " + (e?.message || String(e)), type: "error" });
    }
  };

  const handleManualDni = () => {
    const value = manualDni.trim();
    if (!PURE_DNI_RE.test(value)) {
      setMsg({ text: "Ingresá un DNI válido (7 a 9 dígitos, sin puntos).", type: "error" });
      return;
    }
    setMemberId(value);
    setManualDni("");
    setMsg({ text: "DNI cargado. Completá los datos.", type: "info" });
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

  // Repara UN carnet viejo: detecta el DNI al inicio del código guardado,
  // copia todos los datos (nombre, alta, vencimiento, retiros) a un nuevo
  // documento con esa clave, crea la traducción en qr_mappings para que
  // el carnet físico se reconozca solo la próxima vez, y borra el registro
  // viejo. No se pierde ningún dato en el proceso.
  const repairBrokenMember = async (m: SubsidizedMember): Promise<string> => {
    const match = m.id.match(/^(\d{7,9})/);
    if (!match) {
      return "⚠️ No se pudo detectar un DNI al inicio del código. Revisar a mano.";
    }
    const dni = match[1];

    const targetRef = doc(db, "subsidized_members", dni);
    const targetSnap = await getDoc(targetRef);
    const { id, ...data } = m as any;

    if (targetSnap.exists()) {
      // Mismo DNI ya registrado bajo otro carnet/QR: es la misma persona con
      // dos códigos distintos (típicamente porque le imprimieron un carnet
      // nuevo). En vez de bloquear, fusionamos: se suman los retiros de
      // ambos, se conserva la fecha de alta más antigua y el vencimiento
      // más generoso, y se borra el duplicado.
      const existing = targetSnap.data() as any;

      const mergedWithdrawals = (existing.totalWithdrawals || 0) + (data.totalWithdrawals || 0);

      const existingExpires = existing.expiresAt?.toDate ? existing.expiresAt.toDate() : null;
      const newExpires = data.expiresAt?.toDate ? data.expiresAt.toDate() : null;
      const mergedExpires =
        existingExpires && newExpires
          ? (existingExpires > newExpires ? existing.expiresAt : data.expiresAt)
          : (existing.expiresAt ?? data.expiresAt);

      const existingCreated = existing.createdAt?.toDate ? existing.createdAt.toDate() : null;
      const newCreated = data.createdAt?.toDate ? data.createdAt.toDate() : null;
      const mergedCreated =
        existingCreated && newCreated
          ? (existingCreated < newCreated ? existing.createdAt : data.createdAt)
          : (existing.createdAt ?? data.createdAt);

      await setDoc(targetRef, {
        name: existing.name || data.name,
        lastName: existing.lastName || data.lastName,
        active: existing.active || data.active,
        createdAt: mergedCreated,
        expiresAt: mergedExpires,
        totalWithdrawals: mergedWithdrawals,
      }, { merge: true });

      const safeRawIdDup = m.id.replace(/\//g, "-");
      await setDoc(doc(db, "qr_mappings", safeRawIdDup), { dni, vinculadoEn: new Date() });

      await deleteDoc(doc(db, "subsidized_members", m.id));

      return `✅ Fusionado con el registro existente del DNI ${dni} (retiros combinados: ${mergedWithdrawals}).`;
    }

    await setDoc(targetRef, data);

    const safeRawId = m.id.replace(/\//g, "-");
    await setDoc(doc(db, "qr_mappings", safeRawId), { dni, vinculadoEn: new Date() });

    await deleteDoc(doc(db, "subsidized_members", m.id));

    return `✅ Vinculado al DNI ${dni}.`;
  };

  const handleRepairAll = async () => {
    if (brokenMembers.length === 0) return;
    if (!confirm(
      `Se van a revincular ${brokenMembers.length} carnet(es) usando el DNI que aparece al inicio de cada código guardado. ` +
      `Se conservan nombre, fecha de alta, vencimiento y retiros. Si el DNI ya existe con otro carnet, se fusionan sumando los retiros. ¿Continuar?`
    )) return;

    setMigrating(true);
    const log: string[] = [];
    for (const m of brokenMembers) {
      try {
        const result = await repairBrokenMember(m);
        log.push(`${m.lastName}, ${m.name} (${m.id.slice(0, 30)}...): ${result}`);
      } catch (e: any) {
        log.push(`${m.lastName}, ${m.name}: ❌ Error - ${e.message || String(e)}`);
      }
    }
    setMigrationLog(log);
    setMigrating(false);
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* --- NAVEGADOR DE SOLAPAS --- */}
      <div style={{ display: "flex", gap: 12, borderBottom: "2px solid #e2e8f0", paddingBottom: 8 }}>
        <button
          onClick={() => setActiveTab("alta")}
          style={{ padding: "8px 16px", fontWeight: "bold", borderRadius: "4px 4px 0 0", background: activeTab === "alta" ? "#3b82f6" : "transparent", color: activeTab === "alta" ? "#fff" : "#4a5568", border: "none", cursor: "pointer" }}
        >
          📋 Alta y Padrón
        </button>
        <button
          onClick={() => setActiveTab("analisis")}
          style={{ padding: "8px 16px", fontWeight: "bold", borderRadius: "4px 4px 0 0", background: activeTab === "analisis" ? "#10b981" : "transparent", color: activeTab === "analisis" ? "#fff" : "#4a5568", border: "none", cursor: "pointer" }}
        >
          📊 Análisis
        </button>
      </div>

      {activeTab === "alta" ? (
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

                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
                  <div style={{ flex: 1, borderBottom: "1px solid #e2e8f0" }} />
                  o
                  <div style={{ flex: 1, borderBottom: "1px solid #e2e8f0" }} />
                </div>

                <div>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>1b) Ingresar DNI manualmente</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      className="input"
                      placeholder="Solo números, sin puntos"
                      value={manualDni}
                      onChange={(e) => setManualDni(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleManualDni()}
                    />
                    <button className="button outline" onClick={handleManualDni}>Usar DNI</button>
                  </div>
                </div>

                {memberId && (
                  <div className="panel" style={{ background: "rgba(var(--brand-rgb), 0.05)" }}>
                    <p style={{ margin: 0, fontSize: 13 }}>ID Carnet (DNI): <b>{memberId}</b></p>
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

            {brokenMembers.length > 0 && (
              <Card title={`🔧 Vincular carnets viejos (${brokenMembers.length})`}>
                <div style={{ display: "grid", gap: 10 }}>
                  <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>
                    Estos socios quedaron guardados con el código crudo del carnet (con nombre, teléfono, etc.)
                    en vez del DNI. Esto hace que Caja no los reconozca como subvencionados. Este botón detecta
                    el DNI al inicio de cada código y los revincula, sin perder nombre, fecha de alta, vencimiento
                    ni retiros acumulados. Si la persona ya tiene otro carnet cargado con ese mismo DNI (por ejemplo,
                    le imprimieron un carnet nuevo), los dos registros se fusionan sumando los retiros de ambos.
                  </p>

                  <div style={{ maxHeight: 160, overflow: "auto", fontSize: 12 }}>
                    {brokenMembers.map((m) => {
                      const match = m.id.match(/^(\d{7,9})/);
                      return (
                        <div key={m.id} style={{ padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                          <b>{m.lastName}, {m.name}</b> — DNI detectado: {match ? match[1] : "❓ no detectado"}
                        </div>
                      );
                    })}
                  </div>

                  <button className="button" disabled={migrating} onClick={handleRepairAll}>
                    {migrating ? "Reparando..." : `Reparar los ${brokenMembers.length} carnet(es)`}
                  </button>

                  {migrationLog.length > 0 && (
                    <div style={{ maxHeight: 180, overflow: "auto", fontSize: 12, background: "rgba(0,0,0,0.15)", padding: 8, borderRadius: 6 }}>
                      {migrationLog.map((line, i) => <div key={i}>{line}</div>)}
                    </div>
                  )}
                </div>
              </Card>
            )}
          </div>

          {/* Columna Derecha: Listado */}
          <Card title="Padrón de Subvencionados">
            <div style={{ maxHeight: "70vh", overflow: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Socio</th>
                    <th>DNI</th>
                    <th>Desde</th>
                    <th>Vence</th>
                    <th>Retiros</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map(m => {
                    const exp = m.expiresAt?.toDate ? m.expiresAt.toDate() : null;
                    const vencido = exp ? exp < new Date() : false;
                    const idRoto = !PURE_DNI_RE.test(m.id);
                    return (
                      <tr key={m.id} style={vencido ? { background: "rgba(239, 68, 68, 0.08)" } : undefined}>
                        <td><b>{m.lastName}, {m.name}</b></td>
                        <td style={idRoto ? { color: "#f59e0b" } : undefined} title={idRoto ? "Código crudo sin vincular al DNI" : undefined}>
                          {m.id}{idRoto && " ⚠️"}
                        </td>
                        {/* Mostramos fecha de alta */}
                        <td>{m.createdAt?.toDate ? m.createdAt.toDate().toLocaleDateString() : '-'}</td>
                        {/* Mostramos vencimiento */}
                        <td>
                          {exp ? exp.toLocaleDateString() : '31/12'}
                          {vencido && <span style={{ marginLeft: 6, fontSize: 11, color: "#b91c1c", fontWeight: 700 }}>VENCIDO</span>}
                        </td>
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {/* KPIs */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
            <KpiCard label="Subvencionados activos" value={analytics.totalActivos} color="#3b82f6" />
            <KpiCard label="Retiros históricos" value={analytics.totalRetiros} color="#10b981" />
            <KpiCard label="Promedio por socio" value={analytics.promedioPorSocio.toFixed(1)} color="#8b5cf6" />
            <KpiCard label="Por vencer (30 días)" value={analytics.porVencer.length} color="#f59e0b" />
            <KpiCard label="Vencidos" value={analytics.vencidos.length} color="#ef4444" />
          </div>

          {/* Tendencia diaria */}
          <div className="panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontWeight: 700 }}>Viandas subvencionadas por día</div>
              <select
                className="input"
                style={{ width: 160 }}
                value={trendDays}
                onChange={(e) => setTrendDays(Number(e.target.value))}
              >
                <option value={7}>Últimos 7 días</option>
                <option value={14}>Últimos 14 días</option>
                <option value={30}>Últimos 30 días</option>
              </select>
            </div>
            <div style={{ height: 260 }}>
              {trendLoading ? (
                <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>
                  Cargando...
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="subvencionados" fill="#3b82f6" name="Subvencionados" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {/* Ranking de mayor uso */}
            <Card title="Top 10 - Mayor uso del beneficio">
              {analytics.ranking.length === 0 ? (
                <p style={{ color: "var(--muted)", fontStyle: "italic" }}>Sin datos todavía.</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr><th>Socio</th><th>DNI</th><th>Retiros</th></tr>
                  </thead>
                  <tbody>
                    {analytics.ranking.map((m) => (
                      <tr key={m.id}>
                        <td>{m.lastName}, {m.name}</td>
                        <td>{m.id}</td>
                        <td style={{ textAlign: "center" }}>{m.totalWithdrawals || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            {/* Sin uso registrado */}
            <Card title={`Sin uso registrado (${analytics.sinUso.length})`}>
              {analytics.sinUso.length === 0 ? (
                <p style={{ color: "var(--muted)", fontStyle: "italic" }}>Todos los subvencionados activos ya usaron el beneficio.</p>
              ) : (
                <div style={{ maxHeight: 260, overflow: "auto" }}>
                  <table className="table">
                    <thead>
                      <tr><th>Socio</th><th>DNI</th><th>Alta</th></tr>
                    </thead>
                    <tbody>
                      {analytics.sinUso.map((m) => (
                        <tr key={m.id}>
                          <td>{m.lastName}, {m.name}</td>
                          <td>{m.id}</td>
                          <td>{m.createdAt?.toDate ? m.createdAt.toDate().toLocaleDateString() : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                Están cargados en el padrón pero nunca retiraron una vianda. Puede servir para verificar que el carnet
                esté bien vinculado, o para dar de baja beneficios que ya no se usan.
              </p>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="panel" style={{ textAlign: "center" }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}
