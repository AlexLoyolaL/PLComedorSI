// src/pages/Supervisor.tsx
import { useEffect, useState } from "react";
import { collection, getDocs, orderBy, query, where, limit, startAfter, documentId, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { Card } from "../ui/Card";
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  PieChart, Pie, Cell
} from "recharts";
import * as XLSX from "xlsx";

type Row = {
  id: string;
  dateKey: string;
  ts: any;
  seller: { email?: string };
  member: { id?: string };
  itemType: "MENU" | "VEGGIE" | "CELIACO";
  destination: { mode: "COMEDOR" | "VIANDA"; table?: string | null };
  voided?: boolean;
  manual?: boolean;
  manualConcept?: string;
  manualNote?: string;
  isSubsidized?: boolean;
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

export default function Supervisor() {
  const endDefault = new Date();
  const startDefault = addDays(endDefault, -6);

  const [start, setStart] = useState<string>(toDateInputValue(startDefault));
  const [end, setEnd] = useState<string>(toDateInputValue(endDefault));
  
  // Paginación
  const [rows, setRows] = useState<Row[]>([]);
  const [lastDoc, setLastDoc] = useState<any>(null);
  const [hasMore, setHasMore] = useState(true);
  
  // Gráficos y Métricas
  const [dailyData, setDailyData] = useState<any[]>([]);
  const [pieData, setPieData] = useState<any[]>([]);
  const [uniqueCount, setUniqueCount] = useState<number | null>(null);

  // Checkbox de Auditoría
  const [showSubsidized, setShowSubsidized] = useState(false);

  // Nombre y apellido de los socios subsidiados (Gabinete Social), para
  // mostrarlos junto al DNI en la tabla y en los exports.
  const [subsidizedNames, setSubsidizedNames] = useState<Record<string, { name: string; lastName: string }>>({});

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "subsidized_members"), (snap) => {
      const map: Record<string, { name: string; lastName: string }> = {};
      snap.forEach((d) => {
        const data = d.data() as any;
        map[d.id] = { name: data?.name ?? "", lastName: data?.lastName ?? "" };
      });
      setSubsidizedNames(map);
    });
    return () => unsub();
  }, []);

  // Estados de carga
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [calculatingExport, setCalculatingExport] = useState(false);
  const [err, setErr] = useState<string>("");

  async function loadChartsData() {
    try {
      const qAgg = query(
        collection(db, "dayAgg"), 
        where(documentId(), ">=", start), 
        where(documentId(), "<=", end)
      );
      const snap = await getDocs(qAgg);
      
      const dData: any[] = [];
      
      // Contadores acumulados para la torta
      let totalMenu = 0;
      let totalVeggie = 0;
      let totalCeliaco = 0;

      snap.forEach((doc) => {
        const d = doc.data() as any;
        
        // 1. Sumamos las cantidades físicas del día (comedor + vianda)
        const cM = d.comedor?.MENU || 0;
        const cV = d.comedor?.VEGGIE || 0;
        const cC = d.comedor?.CELIACO || 0;
        const vM = d.vianda?.MENU || 0;
        const vV = d.vianda?.VEGGIE || 0;
        const vC = d.vianda?.CELIACO || 0;
        
        totalMenu += (cM + vM);
        totalVeggie += (cV + vV);
        totalCeliaco += (cC + vC);

        // 2. Lógica financiera (la que ya tenías)
        let paid = d.financial?.paid;
        let subsidized = d.financial?.subsidized || 0;

        if (paid === undefined) {
          paid = cM + cV + cC + vM + vV + vC;
        }

        const cash = d.payments?.cash || 0;
        const mp = d.payments?.mp || 0;

        dData.push({ 
          date: doc.id, 
          paid: paid, 
          subsidized: subsidized,
          cash: cash,
          mp: mp
        });
      });

      dData.sort((a, b) => a.date.localeCompare(b.date));
      setDailyData(dData);
      
      // 3. Seteamos la información de la torta
      setPieData([
        { name: "Menú", value: totalMenu, color: "#3b82f6" },     // Azul
        { name: "Veggie", value: totalVeggie, color: "#10b981" }, // Verde
        { name: "Celíaco", value: totalCeliaco, color: "#f59e0b" } // Naranja
      ].filter(item => item.value > 0)); // Filtramos los que estén en cero para no renderizar pedazos vacíos

    } catch (e) {
      console.error("Error cargando gráficos", e);
    }
  }

  // 2. CARGA DE LA TABLA LIMITADA A 20
  async function loadFirstPage() {
    try {
      setLoading(true);
      setErr("");
      const qRef = query(
        collection(db, "sales"),
        where("dateKey", ">=", start),
        where("dateKey", "<=", end),
        orderBy("dateKey", "desc"),
        limit(20)
      );
      const snap = await getDocs(qRef);
      
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as Row));
      list.sort((a, b) => (b.ts?.toMillis?.() || 0) - (a.ts?.toMillis?.() || 0));
      
      setRows(list);
      setLastDoc(snap.docs[snap.docs.length - 1]);
      setHasMore(snap.docs.length === 20);
      setUniqueCount(null);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (start && end && start <= end) {
      loadChartsData();
      loadFirstPage();
    }
  }, [start, end]);

  // CARGAR 20 MÁS
  async function loadNextPage() {
    if (!lastDoc) return;
    try {
      setLoadingMore(true);
      const qRef = query(
        collection(db, "sales"),
        where("dateKey", ">=", start),
        where("dateKey", "<=", end),
        orderBy("dateKey", "desc"),
        startAfter(lastDoc),
        limit(20)
      );
      const snap = await getDocs(qRef);
      
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as Row));
      list.sort((a, b) => (b.ts?.toMillis?.() || 0) - (a.ts?.toMillis?.() || 0));
      
      setRows(prev => [...prev, ...list]);
      setLastDoc(snap.docs[snap.docs.length - 1]);
      setHasMore(snap.docs.length === 20);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  // 3. DESCARGA COMPLETA (Solo on demand)
  async function fetchAllForExport() {
    const qRef = query(collection(db, "sales"), where("dateKey", ">=", start), where("dateKey", "<=", end));
    const snap = await getDocs(qRef);
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as Row));
  }

  // CÁLCULO DE PERSONAS ÚNICAS
  async function calculateUniqueUsers() {
    setCalculatingExport(true);
    try {
      const allRows = await fetchAllForExport();
      const uniqueIds = new Set();
      allRows.forEach(r => {
        if (!r.voided && r.member?.id) uniqueIds.add(r.member.id);
      });
      setUniqueCount(uniqueIds.size);
    } catch (e) {
      alert("Error calculando personas únicas");
    } finally {
      setCalculatingExport(false);
    }
  }

  async function downloadCsv() {
    setCalculatingExport(true);
    try {
      const allRows = await fetchAllForExport();
      const header = ["fecha", "hora", "vendedor", "socio", "apellido", "nombre", "tipo", "destino", "mesa", "observaciones"];
      const lines = allRows
        .filter((r) => !r.voided)
        .map((r) => {
          const info = r.isSubsidized ? subsidizedNames[r.member?.id ?? ""] : undefined;
          return [
            r.dateKey,
            r.ts?.toDate ? r.ts.toDate().toLocaleTimeString() : "",
            r.seller?.email ?? "",
            r.member?.id ?? "",
            info?.lastName ?? "",
            info?.name ?? "",
            r.itemType,
            r.destination?.mode ?? "",
            r.destination?.table ?? "",
            r.manualNote ?? "",
          ];
        });

      const csv = [header, ...lines].map((a) => a.join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `ventas_${start}_a_${end}.csv`; a.click();
      URL.revokeObjectURL(url);
    } finally {
      setCalculatingExport(false);
    }
  }

  async function exportXLSX() {
    setCalculatingExport(true);
    try {
      const allRows = await fetchAllForExport();
      const data = allRows
        .filter((r) => !r.voided)
        .map((r) => {
          const info = r.isSubsidized ? subsidizedNames[r.member?.id ?? ""] : undefined;
          return {
            Fecha: r.dateKey ?? "",
            Hora: r.ts?.toDate ? r.ts.toDate().toLocaleTimeString() : "",
            Vendedor: r.seller?.email ?? "",
            Socio: r.member?.id ?? "",
            Apellido: info?.lastName ?? "",
            Nombre: info?.name ?? "",
            Tipo: r.itemType ?? "",
            Destino: r.destination?.mode ?? "",
            Mesa: r.destination?.table ?? "",
            Observaciones: r.manualNote ?? "",
          };
        });

      const wsVentas = XLSX.utils.json_to_sheet(data);
      wsVentas["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 25 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 30 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, wsVentas, "Ventas");

      // Cargas manuales
      const adminQ = query(collection(db, "adminAdds"), where("dateKey", ">=", start), where("dateKey", "<=", end));
      const adminSnap = await getDocs(adminQ);
      const manualDocs = adminSnap.docs.map((d) => d.data() as any);

      if (manualDocs.length > 0) {
        const manualData = manualDocs.map((r: any) => ({
          Fecha: r.dateKey ?? "",
          Hora: r.ts?.toDate ? r.ts.toDate().toLocaleTimeString() : "",
          Usuario: r.seller?.email ?? "",
          Cantidad: r.qty ?? 0,
          Tipo: r.itemType ?? "",
          Concepto: (r.concept ?? "").toString().replace("_", " "),
          Reporte: r.note ?? "",
        }));

        const wsManual = XLSX.utils.json_to_sheet(manualData);
        wsManual["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 25 }, { wch: 10 }, { wch: 10 }, { wch: 20 }, { wch: 40 }];
        XLSX.utils.book_append_sheet(wb, wsManual, "Cargas manuales");
      }

      XLSX.writeFile(wb, `ventas_${start}_a_${end}.xlsx`);
    } finally {
      setCalculatingExport(false);
    }
  }

  const rangeInvalid = start > end;

  return (
    <div className="grid cols-1">
      <Card title="Panel de Supervisor">
        {/* Filtros */}
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
          <div style={{ fontWeight: 600 }}>Desde:</div>
          <input type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} style={{ width: 140 }} />
          <div style={{ fontWeight: 600 }}>Hasta:</div>
          <input type="date" className="input" value={end} onChange={(e) => setEnd(e.target.value)} style={{ width: 140 }} />
          
          <button className="button outline" onClick={downloadCsv} disabled={rangeInvalid || calculatingExport}>
            {calculatingExport ? "Generando..." : "Descargar CSV"}
          </button>
          <button className="button" onClick={exportXLSX} disabled={rangeInvalid || calculatingExport}>
            {calculatingExport ? "Generando Excel..." : "Descargar Excel"}
          </button>
        </div>

        {rangeInvalid && (
          <div className="panel" style={{ borderColor: "var(--danger)" }}>
            Rango inválido: "Desde" debe ser anterior o igual a "Hasta".
          </div>
        )}

        {/* Sección Personas Únicas */}
        <div className="panel" style={{ display: "flex", alignItems: "center", gap: 16, background: "rgba(34, 197, 94, 0.05)", borderColor: "#22c55e" }}>
          <div>
            <div style={{ fontWeight: 700, color: "#22c55e" }}>Personas Únicas Asistentes</div>
            <div style={{ fontSize: 13, color: "var(--muted)" }}>¿A cuántas personas diferentes le dimos de comer en estas fechas?</div>
          </div>
          <div style={{ marginLeft: "auto" }}>
            {uniqueCount !== null ? (
              <span style={{ fontSize: 24, fontWeight: "bold", color: "#22c55e" }}>{uniqueCount} personas</span>
            ) : (
              <button className="button" style={{ background: "#22c55e" }} onClick={calculateUniqueUsers} disabled={calculatingExport}>
                Calcular Métrica Exacta
              </button>
            )}
          </div>
        </div>

        {/* Gráficos */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
          
          {/* Gráfico 1: Ventas Diarias (Apilado) */}
          <div className="panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontWeight: 700, color: "#fff" }}>Ventas Diarias (Auditoría)</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: '#fff' }}>
                <input 
                  type="checkbox" 
                  checked={showSubsidized} 
                  onChange={(e) => setShowSubsidized(e.target.checked)} 
                />
                Incluir Subvencionados
              </label>
            </div>
            
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(204, 204, 204, 1)" />
                  <XAxis dataKey="date" tick={{ fill: "#fff" }} />
                  <YAxis allowDecimals={false} tick={{ fill: "#fff" }} />
                  <Tooltip contentStyle={{ background: "rgba(18, 24, 42, 0.95)", border: "1px solid #334", color: "#fff" }} />
                  <Legend wrapperStyle={{ color: "#fff", paddingTop: 10 }} />
                  
                  {/* stackId agrupa las barras */}
                  <Bar dataKey="paid" stackId="a" fill="#10b981" name="Ventas Pagadas" />
                  {showSubsidized && (
                    <Bar dataKey="subsidized" stackId="a" fill="#3b82f6" name="Subvencionados (Gratis)" />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Gráfico 2: Rendición (Medios de Pago) */}
          <div className="panel">
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#fff" }}>Medios de Pago (Rendición)</div>
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(204, 204, 204, 1)" />
                  <XAxis dataKey="date" tick={{ fill: "#fff" }} />
                  <YAxis allowDecimals={false} tick={{ fill: "#fff" }} />
                  <Tooltip contentStyle={{ background: "rgba(18, 24, 42, 0.95)", border: "1px solid #334", color: "#fff" }} />
                  <Legend wrapperStyle={{ color: "#fff", paddingTop: 10 }} />
                  
                  {/* Estas barras van lado a lado para poder comparar */}
                  <Bar dataKey="cash" fill="#f59e0b" name="Ventas en Efectivo" />
                  <Bar dataKey="mp" fill="#8b5cf6" name="Mercado Pago / Tarjeta" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
  
          {/* NUEVO Gráfico 3: Torta de Distribución */}
          <div className="panel">
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#fff", textAlign: "center" }}>Distribución de Platos</div>
            <div style={{ height: 260 }}>
              {pieData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`}
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ background: "rgba(18, 24, 42, 0.95)", border: "1px solid #334", borderRadius: 8, color: "#fff" }} 
                      itemStyle={{ color: "#fff" }}
                    />
                    <Legend wrapperStyle={{ color: "#fff", paddingTop: 10 }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ display: "flex", height: "100%", justifyContent: "center", alignItems: "center", color: "var(--muted)" }}>
                  No hay datos para este rango
                </div>
              )}
            </div>
          </div>
          

        </div>

        {/* Tabla Paginada */}
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Últimas ventas en el rango</h3>
            {loading && <span style={{ color: "var(--brand)" }}>Cargando tabla...</span>}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Hora</th>
                <th>Vendedor</th>
                <th>Socio</th>
                <th>Tipo</th>
                <th>Destino</th>
                <th>Mesa</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ opacity: r.voided ? 0.5 : 1 }}>
                  <td>{r.dateKey}</td>
                  <td>{r.ts?.toDate ? r.ts.toDate().toLocaleTimeString() : ""}</td>
                  <td>{r.seller?.email ?? ""}</td>
                  <td>
                    {r.isSubsidized && subsidizedNames[r.member?.id ?? ""]?.name ? (
                      <>
                        {subsidizedNames[r.member!.id!].lastName}, {subsidizedNames[r.member!.id!].name}
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>{r.member?.id}</div>
                      </>
                    ) : (
                      r.member?.id ?? ""
                    )}
                  </td>
                  <td>{r.itemType}</td>
                  <td>{r.destination?.mode ?? ""}</td>
                  <td>{r.destination?.table ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          
          {hasMore && rows.length > 0 && (
            <button 
              className="button outline" 
              style={{ width: "100%", marginTop: 12 }} 
              onClick={loadNextPage}
              disabled={loadingMore}
            >
              {loadingMore ? "Cargando..." : "Cargar 20 más"}
            </button>
          )}

          {err && <div style={{ color: "var(--danger)", marginTop: 8 }}>{err}</div>}
        </div>
      </Card>
    </div>
  );
}