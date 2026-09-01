// src/pages/ListadoQR.tsx
import { useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { Card } from "../ui/Card";
import * as XLSX from "xlsx";

function toDateInputValue(date: Date) {
  const z = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

// Trae, en un solo viaje por colección, los mapas dni -> nombre/apellido y
// dni -> código de QR del carnet viejo. Se comparte entre los dos exports
// de esta página para no duplicar lecturas de más de lo necesario.
async function fetchNameAndQrMaps() {
  const subSnap = await getDocs(collection(db, "subsidized_members"));
  const subByDni: Record<string, { apellido: string; nombre: string }> = {};
  subSnap.forEach((d) => {
    const data = d.data() as any;
    subByDni[d.id] = { apellido: data?.lastName ?? "", nombre: data?.name ?? "" };
  });

  const memSnap = await getDocs(collection(db, "members"));
  const memByDni: Record<string, string> = {};
  memSnap.forEach((d) => {
    const data = d.data() as any;
    if (data?.name && data.name !== "Socio Nuevo (Creado por MP)") memByDni[d.id] = data.name;
  });

  // El id del doc en qr_mappings ES el código crudo del carnet viejo; el
  // campo dni adentro apunta al socio.
  const qrSnap = await getDocs(collection(db, "qr_mappings"));
  const qrByDni: Record<string, string> = {};
  qrSnap.forEach((d) => {
    const data = d.data() as any;
    if (data?.dni) qrByDni[data.dni] = d.id;
  });

  return { subByDni, memByDni, qrByDni };
}

// Página exclusiva para ROOT: genera bajo demanda (nunca en tiempo real, para
// no consumir lecturas de Firestore de forma innecesaria) Excels con los
// socios que compraron en un rango de fechas, junto con el código de QR de
// su carnet viejo cuando lo tienen, para cruzar contra el listado de QR
// escaneados en el área de acceso.
export default function ListadoQR() {
  const [since, setSince] = useState<string>(toDateInputValue(new Date(new Date().getFullYear(), 6, 1))); // 1 de julio del año en curso, por defecto
  const [until, setUntil] = useState<string>(toDateInputValue(new Date()));
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [loadingDaily, setLoadingDaily] = useState(false);
  const [lastResultCount, setLastResultCount] = useState<{ mode: "resumen" | "diario"; count: number } | null>(null);

  async function fetchSalesInRange() {
    const salesSnap = await getDocs(
      query(collection(db, "sales"), where("dateKey", ">=", since), where("dateKey", "<=", until))
    );
    return salesSnap.docs.map((d) => d.data() as any).filter((r) => !r.voided && (r.member?.id ?? "").trim());
  }

  // Un socio por fila: resumen de todas sus compras en el rango elegido.
  async function exportSummary() {
    setLoadingSummary(true);
    setLastResultCount(null);
    try {
      const sales = await fetchSalesInRange();

      type Agg = { count: number; first: string; last: string; sawSubsidiado: boolean; sawLote: boolean };
      const byDni = new Map<string, Agg>();
      sales.forEach((r) => {
        const dni = (r.member.id as string).trim();
        const dateKey = r.dateKey ?? "";
        const prev = byDni.get(dni);
        if (!prev) {
          byDni.set(dni, {
            count: 1,
            first: dateKey,
            last: dateKey,
            sawSubsidiado: r.paymentMethod === "SUBVENCIONADO",
            sawLote: r.paymentMethod === "LOTE_PREPAGO",
          });
        } else {
          prev.count += 1;
          if (dateKey < prev.first) prev.first = dateKey;
          if (dateKey > prev.last) prev.last = dateKey;
          if (r.paymentMethod === "SUBVENCIONADO") prev.sawSubsidiado = true;
          if (r.paymentMethod === "LOTE_PREPAGO") prev.sawLote = true;
        }
      });

      if (byDni.size === 0) {
        setLastResultCount({ mode: "resumen", count: 0 });
        alert(`No hubo compras registradas entre el ${since} y el ${until}.`);
        return;
      }

      const { subByDni, memByDni, qrByDni } = await fetchNameAndQrMaps();

      const finalRows = Array.from(byDni.entries())
        .map(([dni, agg]) => {
          const sub = subByDni[dni];
          const origen = sub
            ? "Subsidiado (Gabinete Social)"
            : agg.sawSubsidiado
            ? "Subsidiado (Gabinete Social)"
            : agg.sawLote
            ? "Abono (Mercado Pago)"
            : "Compra regular (Efectivo/MP)";
          return {
            DNI: dni,
            Apellido: sub?.apellido ?? "",
            Nombre: sub?.nombre ?? memByDni[dni] ?? "",
            Origen: origen,
            "Compras en el período": agg.count,
            "Primera compra": agg.first,
            "Última compra": agg.last,
            "Código QR (carnet viejo)": qrByDni[dni] ?? "",
          };
        })
        .sort((a, b) => a["Primera compra"].localeCompare(b["Primera compra"]));

      setLastResultCount({ mode: "resumen", count: finalRows.length });

      const ws = XLSX.utils.json_to_sheet(finalRows);
      ws["!cols"] = [{ wch: 14 }, { wch: 20 }, { wch: 20 }, { wch: 26 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 26 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Socios");
      XLSX.writeFile(wb, `socios_con_compras_${since}_a_${until}.xlsx`);
    } catch (e: any) {
      alert("Error generando el Excel de socios: " + (e?.message || String(e)));
    } finally {
      setLoadingSummary(false);
    }
  }

  // Una fila por cada día en que un socio compró (día + DNI), para saber
  // quién compró cada día puntual, no solo el resumen del rango completo.
  async function exportDaily() {
    setLoadingDaily(true);
    setLastResultCount(null);
    try {
      const sales = await fetchSalesInRange();

      const seen = new Set<string>();
      const dayRows: { dateKey: string; dni: string }[] = [];
      sales.forEach((r) => {
        const dni = (r.member.id as string).trim();
        const dateKey = r.dateKey ?? "";
        const key = `${dateKey}|${dni}`;
        if (seen.has(key)) return;
        seen.add(key);
        dayRows.push({ dateKey, dni });
      });

      if (dayRows.length === 0) {
        setLastResultCount({ mode: "diario", count: 0 });
        alert(`No hubo compras registradas entre el ${since} y el ${until}.`);
        return;
      }

      const { subByDni, memByDni, qrByDni } = await fetchNameAndQrMaps();

      const finalRows = dayRows
        .map(({ dateKey, dni }) => {
          const sub = subByDni[dni];
          return {
            Fecha: dateKey,
            DNI: dni,
            Apellido: sub?.apellido ?? "",
            Nombre: sub?.nombre ?? memByDni[dni] ?? "",
            "Código QR (carnet viejo)": qrByDni[dni] ?? "",
          };
        })
        .sort((a, b) => a.Fecha.localeCompare(b.Fecha) || a.DNI.localeCompare(b.DNI));

      setLastResultCount({ mode: "diario", count: finalRows.length });

      const ws = XLSX.utils.json_to_sheet(finalRows);
      ws["!cols"] = [{ wch: 12 }, { wch: 14 }, { wch: 20 }, { wch: 20 }, { wch: 26 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Compras por día");
      XLSX.writeFile(wb, `compras_por_dia_${since}_a_${until}.xlsx`);
    } catch (e: any) {
      alert("Error generando el Excel diario: " + (e?.message || String(e)));
    } finally {
      setLoadingDaily(false);
    }
  }

  const rangeInvalid = since > until;

  return (
    <div className="grid cols-1">
      <Card title="📋 Descargar Listado QR">
        <p style={{ color: "var(--muted)", marginTop: 0 }}>
          Generá Excels con los socios que compraron en el rango de fechas elegido, junto con el código de QR de su carnet viejo
          cuando lo tienen, para cruzar contra el listado de QR escaneados en el área de acceso.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600 }}>Desde:</span>
          <input type="date" className="input" value={since} onChange={(e) => setSince(e.target.value)} style={{ width: 160 }} />
          <span style={{ fontWeight: 600 }}>Hasta:</span>
          <input type="date" className="input" value={until} onChange={(e) => setUntil(e.target.value)} style={{ width: 160 }} />
        </div>

        {rangeInvalid && (
          <div style={{ marginTop: 8, color: "var(--danger)", fontSize: 13 }}>"Desde" debe ser anterior o igual a "Hasta".</div>
        )}

        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 16 }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Resumen del período</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8, maxWidth: 280 }}>
              Un socio por fila, con el total de compras y su código QR viejo.
            </div>
            <button className="button" onClick={exportSummary} disabled={loadingSummary || rangeInvalid}>
              {loadingSummary ? "Generando..." : "Descargar resumen"}
            </button>
          </div>

          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Registro diario</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8, maxWidth: 280 }}>
              Una fila por cada día en que cada socio compró, con su código QR viejo — para saber quién compró cada día puntual.
            </div>
            <button className="button" onClick={exportDaily} disabled={loadingDaily || rangeInvalid}>
              {loadingDaily ? "Generando..." : "Descargar por día"}
            </button>
          </div>
        </div>

        {lastResultCount !== null && lastResultCount.count > 0 && (
          <div style={{ marginTop: 12, fontSize: 13, color: "var(--muted)" }}>
            {lastResultCount.mode === "resumen"
              ? `Se exportaron ${lastResultCount.count} socios con compras entre el ${since} y el ${until}.`
              : `Se exportaron ${lastResultCount.count} registros (día + socio) entre el ${since} y el ${until}.`}
          </div>
        )}

        <div style={{ marginTop: 16, fontSize: 12, color: "var(--muted)" }}>
          Esta página no consulta datos en tiempo real: cada clic en un botón hace un puñado de consultas puntuales a Firestore,
          para no gastar lecturas de forma innecesaria.
        </div>
      </Card>
    </div>
  );
}
