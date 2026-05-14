import { useEffect, useState } from "react";
import { collection, query, orderBy, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { Card } from "../ui/Card";
import RequireRole from "../components/RequireRole";

// Definición de tipos para la fila de auditoría
type AuditoriaRow = {
  dateKey: string;
  pdfUrl: string;
  observaciones: string;
  realizadoPor: string; // El campo que agregamos para la firma digital
  timestamp: any;
  totales: {
    comensalesTotales: number;
    efectivoPesos: number;
    mpPesos: number;
    qtyEfectivo: number;
    qtyMp: number;
    qtySubvencionados: number;
  };
};

export default function AuditoriaRendicionPage() {
  return (
    <RequireRole allowAny={["root", "administrador", "visor"]}>
      <AuditoriaInner />
    </RequireRole>
  );
}

function AuditoriaInner() {
  const [history, setHistory] = useState<AuditoriaRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Escucha en tiempo real de la colección rendiciones_audit ordenada por fecha descendente
    const q = query(collection(db, "rendiciones_audit"), orderBy("dateKey", "desc"));
    
    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs.map((d) => d.data() as AuditoriaRow);
      setHistory(data);
      setLoading(false);
    });

    return () => unsub();
  }, []);

  return (
    <div className="grid cols-1">
      <Card title="Bóveda de Rendiciones (Auditoría)">
        <p style={{ color: "var(--muted)", marginTop: 0 }}>
          Historial inmutable de los cierres de caja. Aquí se registran los totales financieros y la copia digital (PDF) del cierre.
        </p>

        {loading ? (
          <div style={{ padding: 20, textAlign: "center" }}>Cargando registros...</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Responsable</th>
                  <th>Platos</th>
                  <th>Efectivo ($)</th>
                  <th>M. Pago ($)</th>
                  <th>Subv.</th>
                  <th>Observaciones</th>
                  <th style={{ textAlign: "right" }}>Documento</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.dateKey}>
                    <td style={{ fontWeight: "bold" }}>{row.dateKey}</td>
                    <td style={{ fontSize: "0.9em", color: "var(--muted)" }}>
                      {row.realizadoPor || "N/A"}
                    </td>
                    <td>{row.totales.comensalesTotales}</td>
                    <td style={{ color: "#10b981", fontWeight: "bold" }}>
                      $ {row.totales.efectivoPesos.toLocaleString("es-AR")}
                    </td>
                    <td style={{ color: "#8b5cf6", fontWeight: "bold" }}>
                      $ {row.totales.mpPesos.toLocaleString("es-AR")}
                    </td>
                    <td>{row.totales.qtySubvencionados}</td>
                    <td 
                      style={{ 
                        maxWidth: 150, 
                        whiteSpace: "nowrap", 
                        overflow: "hidden", 
                        textOverflow: "ellipsis" 
                      }} 
                      title={row.observaciones}
                    >
                      {row.observaciones || "-"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {row.pdfUrl ? (
                        <a 
                          href={row.pdfUrl} 
                          target="_blank" 
                          rel="noreferrer" 
                          className="button ghost" 
                          style={{ padding: "4px 12px", fontSize: "0.9em" }}
                        >
                          📄 Ver PDF
                        </a>
                      ) : (
                        <span style={{ color: "var(--muted)", fontSize: 12 }}>Sin archivo</span>
                      )}
                    </td>
                  </tr>
                ))}
                
                {history.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
                      No se han encontrado rendiciones cerradas en el sistema.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}