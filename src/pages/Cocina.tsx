import { doc, onSnapshot, collection, query, where } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import { todayKey, tableLabelFromKey } from "../lib/sales";
import { Card } from "../ui/Card";

type Agg = {
  comedor: { MENU: number; VEGGIE: number; byTable: Record<string, number> };
  vianda: { MENU: number; VEGGIE: number };
  lastUpdated?: any;
};

function emptyAgg(): Agg {
  return { comedor: { MENU: 0, VEGGIE: 0, byTable: {} }, vianda: { MENU: 0, VEGGIE: 0 } };
}

export default function Cocina() {
  const [aggDoc, setAggDoc] = useState<Agg | null>(null);
  const [calc, setCalc] = useState<Agg>(emptyAgg());

  // A) Escucha el agregado del día
  useEffect(() => {
    const key = todayKey();
    const unsub = onSnapshot(doc(db, "dayAgg", key), (snap) => {
      setAggDoc((snap.exists() ? (snap.data() as any) : null) as Agg | null);
    });
    return () => unsub();
  }, []);

  // B) Fallback: si no hay dayAgg, calcula desde sales del día (ignora anuladas)
  useEffect(() => {
    const key = todayKey();
    const q = query(collection(db, "sales"), where("dateKey", "==", key));
    const unsub = onSnapshot(q, (snap) => {
      const tmp = emptyAgg();
      snap.forEach((d) => {
        const r: any = d.data();
        if (r.voided) return;
        const type = r.itemType as "MENU" | "VEGGIE";
        const dest = r.destination?.mode as "COMEDOR" | "VIANDA" | undefined;

        if (dest === "COMEDOR") {
          tmp.comedor[type] = (tmp.comedor[type] ?? 0) + 1;
          const mesaKey =
            // soporta claves nuevas ("M01") y antiguas ("MESA 01")
            (r.destination?.mesaKey as string | undefined) ||
            (r.destination?.tableKey as string | undefined) || // por si en el futuro guardás directo
            (typeof r.destination?.table === "string"
              ? ("M" + r.destination.table.replace(/[^\d]/g, "").padStart(2, "0"))
              : undefined);
          if (mesaKey) tmp.comedor.byTable[mesaKey] = (tmp.comedor.byTable[mesaKey] ?? 0) + 1;
        } else if (dest === "VIANDA") {
          tmp.vianda[type] = (tmp.vianda[type] ?? 0) + 1;
        }
      });
      setCalc(tmp);
    });
    return () => unsub();
  }, []);

  const data: Agg = useMemo(() => aggDoc ?? calc, [aggDoc, calc]);

  const comedor = data.comedor ?? { MENU: 0, VEGGIE: 0, byTable: {} };
  const vianda = data.vianda ?? { MENU: 0, VEGGIE: 0 };

  const mesasOrdenadas = useMemo(() => {
    const entries = Object.entries(comedor.byTable ?? {});
    return entries.sort((a, b) => {
      const na = parseInt(String(a[0]).replace(/[^\d]/g, ""), 10);
      const nb = parseInt(String(b[0]).replace(/[^\d]/g, ""), 10);
      return na - nb;
    });
  }, [comedor.byTable]);

  return (
    <div className="grid cols-2">
      <Card title="COMEDOR">
        <div>MENU: <b>{comedor.MENU ?? 0}</b></div>
        <div>VEGGIE: <b>{comedor.VEGGIE ?? 0}</b></div>
      </Card>

      <Card title="VIANDA">
        <div>MENU: <b>{vianda.MENU ?? 0}</b></div>
        <div>VEGGIE: <b>{vianda.VEGGIE ?? 0}</b></div>
      </Card>

      <Card title="Mesas (ocupados / 9)">
        {mesasOrdenadas.length === 0 ? (
          <div style={{ color: "var(--muted)" }}>Sin ocupación aún.</div>
        ) : (
          <div style={{ columns: 2 }}>
            {mesasOrdenadas.map(([key, cant]) => (
              <div key={key as string}>
                {tableLabelFromKey(key as string)}: <b>{cant as number}</b> / 9
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
