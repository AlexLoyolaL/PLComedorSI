// src/pages/ListadoQR.tsx
import { useState } from "react";
import { collection, getDocs, query, where, Timestamp } from "firebase/firestore";
import { db } from "../firebase";
import { Card } from "../ui/Card";
import * as XLSX from "xlsx";

function toDateInputValue(date: Date) {
  const z = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

// Página exclusiva para ROOT: genera bajo demanda (nunca en tiempo real, para
// no consumir lecturas de Firestore de forma innecesaria) un Excel con los
// socios registrados desde una fecha elegida — subsidiados (Gabinete Social)
// y socios con abono por Mercado Pago — junto con el código de QR de su
// carnet viejo cuando lo tienen, para cruzar contra el listado de QR
// escaneados en el área de acceso.
export default function ListadoQR() {
  const [since, setSince] = useState<string>(toDateInputValue(new Date(new Date().getFullYear(), 6, 1))); // 1 de julio del año en curso, por defecto
  const [loading, setLoading] = useState(false);
  const [lastResultCount, setLastResultCount] = useState<number | null>(null);

  async function exportMembersQR() {
    setLoading(true);
    setLastResultCount(null);
    try {
      const cutoff = Timestamp.fromDate(new Date(`${since}T00:00:00`));

      // 1) Socios subsidiados (Gabinete Social) — tienen nombre y apellido reales.
      const subSnap = await getDocs(query(collection(db, "subsidized_members"), where("createdAt", ">=", cutoff)));
      const subRows = subSnap.docs.map((d) => {
        const data = d.data() as any;
        return {
          dni: d.id,
          apellido: data?.lastName ?? "",
          nombre: data?.name ?? "",
          origen: "Subsidiado (Gabinete Social)",
          createdAt: data?.createdAt,
        };
      });

      // 2) Socios con abono por Mercado Pago — casi nunca tienen nombre real cargado.
      const memSnap = await getDocs(query(collection(db, "members"), where("createdAt", ">=", cutoff)));
      const memRows = memSnap.docs.map((d) => {
        const data = d.data() as any;
        const nombre = data?.name && data.name !== "Socio Nuevo (Creado por MP)" ? data.name : "";
        return {
          dni: d.id,
          apellido: "",
          nombre,
          origen: "Abono (Mercado Pago)",
          createdAt: data?.createdAt,
        };
      });

      // Si el mismo DNI aparece en ambas colecciones, priorizamos el de
      // Gabinete Social porque trae nombre y apellido reales.
      const merged = new Map<string, (typeof subRows)[number]>();
      memRows.forEach((r) => merged.set(r.dni, r));
      subRows.forEach((r) => merged.set(r.dni, r));

      // 3) Reconstruimos dni -> código crudo del carnet viejo. El id del doc
      // en qr_mappings ES ese código; el campo dni adentro apunta al socio.
      const qrSnap = await getDocs(collection(db, "qr_mappings"));
      const qrByDni: Record<string, string> = {};
      qrSnap.forEach((d) => {
        const data = d.data() as any;
        if (data?.dni) qrByDni[data.dni] = d.id;
      });

      const finalRows = Array.from(merged.values())
        .map((r) => ({
          DNI: r.dni,
          Apellido: r.apellido,
          Nombre: r.nombre,
          Origen: r.origen,
          "Fecha de alta": r.createdAt?.toDate ? r.createdAt.toDate().toLocaleDateString("es-AR") : "",
          "Código QR (carnet viejo)": qrByDni[r.dni] ?? "",
          _sort: r.createdAt?.toMillis ? r.createdAt.toMillis() : 0,
        }))
        .sort((a, b) => a._sort - b._sort)
        .map(({ _sort, ...rest }) => rest);

      setLastResultCount(finalRows.length);

      if (finalRows.length === 0) {
        alert(`No hay socios registrados desde el ${since}.`);
        return;
      }

      const ws = XLSX.utils.json_to_sheet(finalRows);
      ws["!cols"] = [{ wch: 14 }, { wch: 20 }, { wch: 20 }, { wch: 26 }, { wch: 14 }, { wch: 26 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Socios");
      XLSX.writeFile(wb, `socios_registrados_desde_${since}.xlsx`);
    } catch (e: any) {
      alert("Error generando el Excel de socios: " + (e?.message || String(e)));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid cols-1">
      <Card title="📋 Descargar Listado QR">
        <p style={{ color: "var(--muted)", marginTop: 0 }}>
          Genera un Excel con los socios registrados desde la fecha elegida (subsidiados de Gabinete Social + socios con abono
          por Mercado Pago), incluyendo DNI, nombre, apellido y el código de QR de su carnet viejo cuando lo tienen, para
          cruzar contra el listado de QR escaneados en el área de acceso.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600 }}>Desde:</span>
          <input type="date" className="input" value={since} onChange={(e) => setSince(e.target.value)} style={{ width: 160 }} />
          <button className="button" onClick={exportMembersQR} disabled={loading}>
            {loading ? "Generando..." : "Descargar Excel"}
          </button>
        </div>

        {lastResultCount !== null && lastResultCount > 0 && (
          <div style={{ marginTop: 12, fontSize: 13, color: "var(--muted)" }}>
            Se exportaron {lastResultCount} socios registrados desde el {since}.
          </div>
        )}

        <div style={{ marginTop: 16, fontSize: 12, color: "var(--muted)" }}>
          Esta página no consulta datos en tiempo real: cada clic en "Descargar Excel" hace una consulta puntual a Firestore, para
          no gastar lecturas de forma innecesaria.
        </div>
      </Card>
    </div>
  );
}
