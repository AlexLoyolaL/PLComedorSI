// src/pages/Supervisor.tsx
import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { Card } from "../ui/Card";
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from "recharts";

type Row = {
  id: string;
  dateKey: string; // YYYY-MM-DD
  ts: any; // Firestore Timestamp
  seller: { email?: string };
  member: { id?: string };
  itemType: "MENU" | "VEGGIE";
  destination: { mode: "COMEDOR" | "VIANDA"; table?: string | null };
  voided?: boolean;
};

// helpers fecha
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
  // últimos 7 días
  const endDefault = new Date();
  const startDefault = addDays(endDefault, -6);

  const [start, setStart] = useState<string>(toDateInputValue(startDefault));
  const [end, setEnd] = useState<string>(toDateInputValue(endDefault));
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    async function fetchRange() {
      try {
        setLoading(true);
        setErr("");
        const qRef = query(
          collection(db, "sales"),
          where("dateKey", ">=", start),
          where("dateKey", "<=", end),
          orderBy("dateKey")
        );
        const snap = await getDocs(qRef);
        const list: Row[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as any) }));
        // tabla: fecha desc, hora desc
        list.sort((a, b) => {
          if (a.dateKey < b.dateKey) return 1;
          if (a.dateKey > b.dateKey) return -1;
          const ta = a.ts?.toDate ? a.ts.toDate().getTime() : 0;
          const tb = b.ts?.toDate ? b.ts.toDate().getTime() : 0;
          return tb - ta;
        });
        setRows(list);
      } catch (e: any) {
        setErr(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    }
    if (start && end && start <= end) fetchRange();
  }, [start, end]);

  // agregados (daily + pie)
  const { dailyData, pieData } = useMemo(() => {
    const dailyMap = new Map<string, number>();
    let menu = 0, veggie = 0;
    for (const r of rows) {
      if (r.voided) continue;
      dailyMap.set(r.dateKey, (dailyMap.get(r.dateKey) ?? 0) + 1);
      if (r.itemType === "MENU") menu++;
      else if (r.itemType === "VEGGIE") veggie++;
    }
    const dailyData = Array.from(dailyMap.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, total]) => ({ date, total }));
    const pieData = [
      { name: "MENU", value: menu },
      { name: "VEGGIE", value: veggie },
    ];
    return { dailyData, pieData };
  }, [rows]);

  // CSV
  const csv = useMemo(() => {
    const header = ["fecha", "hora", "vendedor", "socio", "tipo", "destino", "mesa"];
    const lines = rows
      .filter((r) => !r.voided)
      .map((r) => [
        r.dateKey,
        r.ts?.toDate ? r.ts.toDate().toLocaleTimeString() : "",
        r.seller?.email ?? "",
        r.member?.id ?? "",
        r.itemType,
        r.destination?.mode ?? "",
        r.destination?.table ?? "",
      ]);
    return [header, ...lines].map((a) => a.join(",")).join("\n");
  }, [rows]);

  function downloadCsv() {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ventas_${start}_a_${end}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const rangeInvalid = start > end;

  return (
    <div className="grid cols-1">
      <Card title="Supervisor">
        {/* Filtros */}
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 600 }}>Desde:</div>
          <input
            type="date"
            className="input"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            style={{ width: 180 }}
          />
          <div style={{ fontWeight: 600 }}>Hasta:</div>
          <input
            type="date"
            className="input"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            style={{ width: 180 }}
          />
          <button className="button" onClick={downloadCsv} disabled={rangeInvalid || rows.length === 0}>
            Exportar CSV
          </button>
          <div style={{ marginLeft: "auto", color: "var(--muted)" }}>
            {loading ? "Cargando..." : `${rows.filter(r=>!r.voided).length} ventas`}
          </div>
        </div>

        {rangeInvalid && (
          <div className="panel" style={{ marginTop: 12, borderColor: "var(--danger)" }}>
            Rango inválido: "Desde" debe ser anterior o igual a "Hasta".
          </div>
        )}

        {/* Gráficos */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
          {/* Barras por día (usa dailyData) */}
          <div className="panel">
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#fff" }}>Ventas diarias</div>
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.2)" />
                  <XAxis dataKey="date" tick={{ fill: "#fff" }} />
                  <YAxis allowDecimals={false} tick={{ fill: "#fff" }} />
                  <Tooltip
                    contentStyle={{ background: "rgba(20,24,36,.95)", border: "1px solid #334", color: "#fff" }}
                    labelStyle={{ color: "#fff" }}
                    itemStyle={{ color: "#fff" }}
                  />
                  <Bar dataKey="total" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Pie MENU vs VEGGIE con colores solicitados */}
          <div className="panel">
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#fff" }}>MENU vs VEGGIE</div>
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Tooltip
                    contentStyle={{ background: "rgba(20,24,36,.95)", border: "1px solid #334", color: "#fff" }}
                    labelStyle={{ color: "#fff" }}
                    itemStyle={{ color: "#fff" }}
                  />
                  <Legend wrapperStyle={{ color: "#fff" }} />
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={50}
                    outerRadius={90}
                    labelLine={false}
                    label={({
                      cx = 0,
                      cy = 0,
                      midAngle = 0,
                      innerRadius = 0,
                      outerRadius = 0,
                      name,
                      value,
                    }: any) => {
                      const RAD = Math.PI / 180;
                      const r = Number(innerRadius) + (Number(outerRadius) - Number(innerRadius)) * 0.62;
                      const x = Number(cx) + r * Math.cos(-Number(midAngle) * RAD);
                      const y = Number(cy) + r * Math.sin(-Number(midAngle) * RAD);
                      return (
                        <text
                          x={x}
                          y={y}
                          fill="#fff"
                          fontSize={12}
                          textAnchor={x > Number(cx) ? "start" : "end"}
                          dominantBaseline="central"
                        >
                          {`${name}: ${value}`}
                        </text>
                      );
                    }}
                  >
                    {pieData.map((entry, i) => (
                      <Cell
                        key={`slice-${i}`}
                        fill={entry.name === "VEGGIE" ? "#235a40" : "#ffffff"}
                        stroke="rgba(255,255,255,.15)"
                      />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Tabla */}
        <div style={{ marginTop: 16 }}>
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
                  <td>{r.member?.id ?? ""}</td>
                  <td>{r.itemType}</td>
                  <td>{r.destination?.mode ?? ""}</td>
                  <td>{r.destination?.table ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {err && <div style={{ color: "var(--danger)", marginTop: 8 }}>{err}</div>}
        </div>
      </Card>
    </div>
  );
}
