import { doc, onSnapshot, collection, query, where } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import { todayKey, tableLabelFromKey } from "../lib/sales";
import { Card } from "../ui/Card";

type ItemType = "MENU" | "VEGGIE" | "CELIACO";

type Agg = {
  comedor: { MENU: number; VEGGIE: number; CELIACO: number; byTable: Record<string, number> };
  vianda: { MENU: number; VEGGIE: number; CELIACO: number };
  lastUpdated?: any;
};

function emptyAgg(): Agg {
  return {
    comedor: { MENU: 0, VEGGIE: 0, CELIACO: 0, byTable: {} },
    vianda: { MENU: 0, VEGGIE: 0, CELIACO: 0 },
  };
}

export default function Cocina() {
  const [aggDoc, setAggDoc] = useState<Agg | null>(null);
  const [calc, setCalc] = useState<Agg>(emptyAgg());

  const [adminAgg, setAdminAgg] = useState<{ MENU: number; VEGGIE: number; CELIACO: number }>({
  MENU: 0,
  VEGGIE: 0,
  CELIACO: 0,
});

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

        const type = (r.itemType as ItemType) ?? "MENU";
        const dest = r.destination?.mode as "COMEDOR" | "VIANDA" | undefined;

        if (dest === "COMEDOR") {
          tmp.comedor[type] = (tmp.comedor[type] ?? 0) + 1;

          const mesaKey =
            (r.destination?.mesaKey as string | undefined) ||
            (r.destination?.tableKey as string | undefined) ||
            (typeof r.destination?.table === "string"
              ? "M" + r.destination.table.replace(/[^\d]/g, "").padStart(2, "0")
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
  // C) Escucha agregados manuales del admin (añade a lo que ya hay)
  useEffect(() => {
    const today = todayKey();
    const unsub = onSnapshot(collection(db, "adminAdds"), (snap) => {
      const agg = { MENU: 0, VEGGIE: 0, CELIACO: 0 } as Record<ItemType, number>;

      snap.forEach((d) => {
        const r: any = d.data();
        if (r.dateKey !== today) return;

        const t = (r.itemType as ItemType) ?? "MENU";
        const q = Number(r.qty) || 0;
        if (t === "MENU" || t === "VEGGIE" || t === "CELIACO") {
          agg[t] = (agg[t] ?? 0) + q;
        }
      });

      setAdminAgg({
        MENU: agg.MENU,
        VEGGIE: agg.VEGGIE,
        CELIACO: agg.CELIACO,
      });
    });

    return () => unsub();
  }, []);


  const data: Agg = useMemo(() => aggDoc ?? calc, [aggDoc, calc]);

  const comedor = data.comedor ?? { MENU: 0, VEGGIE: 0, CELIACO: 0, byTable: {} };
  const vianda = data.vianda ?? { MENU: 0, VEGGIE: 0, CELIACO: 0 };

  const mesasOrdenadas = useMemo(() => {
    const entries = Object.entries(comedor.byTable ?? {});
    return entries.sort((a, b) => {
      const na = parseInt(String(a[0]).replace(/[^\d]/g, ""), 10);
      const nb = parseInt(String(b[0]).replace(/[^\d]/g, ""), 10);
      return na - nb;
    });
  }, [comedor.byTable]);

  // separar en normales y anexo
  const normales = mesasOrdenadas.filter(([k]) => {
    const n = parseInt(String(k).replace(/[^\d]/g, ""), 10);
    return n >= 1 && n <= 23;
  });
  const anexo = mesasOrdenadas.filter(([k]) => {
    const n = parseInt(String(k).replace(/[^\d]/g, ""), 10);
    return n >= 24 && n <= 34;
  });

  const renderMesas = (lista: [string, number][], limite: number) => (
    <div style={{ columns: 2 }}>
      {lista.map(([key, cant]) => (
        <div key={key}>
          {tableLabelFromKey(key)}: <b>{cant}</b> / {limite}
        </div>
      ))}
    </div>
  );

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: "16px",
        justifyItems: "stretch",
        alignItems: "start",
      }}
    >
      {/* FILA SUPERIOR */}
      <Card title="COMEDOR">
        <div>MENU: <b>{comedor.MENU ?? 0}</b></div>
        <div>VEGGIE: <b>{comedor.VEGGIE ?? 0}</b></div>
        <div>CELIACO: <b>{comedor.CELIACO ?? 0}</b></div>
      </Card>

      <Card title="VIANDA">
        <div>MENU: <b>{vianda.MENU ?? 0}</b></div>
        <div>VEGGIE: <b>{vianda.VEGGIE ?? 0}</b></div>
        <div>CELIACO: <b>{vianda.CELIACO ?? 0}</b></div>
      </Card>

      <Card title="Solicitado por Administración">
        <div>MENU: <b>{adminAgg.MENU}</b></div>
        <div>VEGGIE: <b>{adminAgg.VEGGIE}</b></div>
        <div>CELIACO: <b>{adminAgg.CELIACO}</b></div>
      </Card>

      {/* FILA INFERIOR: Mesas (ocupados) centrado */}
      <div
        style={{
          gridColumn: "1 / -1",
          justifySelf: "left",
          width: "100%",
          maxWidth: 600,
        }}
      >
        <Card title="Mesas (ocupados)">
          {mesasOrdenadas.length === 0 ? (
            <div style={{ color: "var(--muted)" }}>Sin ocupación aún.</div>
          ) : (
            <>
              <h4>Salón principal (límite 9)</h4>
              {renderMesas(normales, 9)}

              <h4 style={{ marginTop: "1em" }}>Anexo (límite 8)</h4>
              {renderMesas(anexo, 8)}
            </>
          )}
        </Card>
      </div>
    </div>
  );


}
