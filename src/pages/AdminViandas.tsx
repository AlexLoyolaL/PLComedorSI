import { useState, useEffect } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { Card } from "../ui/Card";
import { addManualViandas, todayKey} from "../lib/sales";
import { useAuth } from "../state/AuthContext";
import RequireRole from "../components/RequireRole"; // el que permite allowAny
import type { ViandaConcept } from "../lib/sales";

export default function AdminViandasPage() {
  return (
    <RequireRole allowAny={["admin"]}>
      <AdminViandasInner />
    </RequireRole>
  );
}

function AdminViandasInner() {
  const { user } = useAuth();
  const [qty, setQty] = useState<number>(1);
  const [concept, setConcept] = useState<ViandaConcept>("PERSONAL");
  const [msg, setMsg] = useState<string>("");

  // Mostrar totales y desglose actual (en vivo)
  const [extra, setExtra] = useState<{ total: number, breakdown: Record<string, number> }>({
    total: 0, breakdown: {}
  });
  const [viandaMenu, setViandaMenu] = useState<number>(0);
  const [viandaVeggie, setViandaVeggie] = useState<number>(0);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "dayAgg", todayKey()), (snap) => {
      const d = snap.data() as any || {};
      setViandaMenu(d?.vianda?.MENU || 0);
      setViandaVeggie(d?.vianda?.VEGGIE || 0);
      setExtra({
        total: d?.extra?.vianda?.total || 0,
        breakdown: d?.extra?.vianda?.breakdown || {}
      });
    });
    return () => unsub();
  }, []);

  async function handleAdd() {
    setMsg("");
    try {
      if (!user) throw new Error("No autenticado");
      await addManualViandas({
        qty: Number(qty),
        concept,
        seller: { uid: user.uid, email: user.email || "", name: user.displayName || "" }
      });
      setMsg(`Se agregaron ${qty} viandas (${concept.replace("_"," ")})`);
      setQty(1);
    } catch (e: any) {
      setMsg(e?.message || String(e));
    }
  }

  return (
    <div className="grid cols-1">
      <Card title="Cargar viandas manuales (solo Admin)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "end" }}>
          <div>
            <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>Cantidad</label>
            <input
              type="number"
              min={1}
              className="input"
              value={qty}
              onChange={(e) => setQty(Number(e.target.value))}
              style={{ maxWidth: 200 }}
            />
          </div>

          <div>
            <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>Concepto</label>
            <select
              className="input"
              value={concept}
              onChange={(e) => setConcept(e.target.value as ViandaConcept)}
              style={{ maxWidth: 280 }}
            >
              <option value="PERSONAL">Para el personal</option>
              <option value="DESAYUNO">Por desayuno</option>
              <option value="CENTRO_JUBILADOS">Centro de jubilados</option>
            </select>
          </div>

          <div>
            <button className="button" onClick={handleAdd}>Agregar a VIANDA (MENU)</button>
          </div>
        </div>

        {msg && (
          <div className="panel" style={{ marginTop: 12, borderColor: msg.startsWith("Se agregaron") ? "var(--ok)" : "var(--danger)" }}>
            {msg}
          </div>
        )}
      </Card>

      <Card title={`Resumen hoy ${todayKey()}`}>
        <div className="panel">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>VIANDA totales</div>
          <div>MENU: <b>{viandaMenu}</b></div>
          <div>VEGGIE: <b>{viandaVeggie}</b></div>
        </div>
        <div className="panel" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Cargas manuales</div>
          <div>Total extra: <b>{extra.total}</b></div>
          <ul style={{ marginTop: 8 }}>
            {Object.entries(extra.breakdown).map(([k, v]) => (
              <li key={k}>{k.replace("_"," ")}: <b>{v}</b></li>
            ))}
            {Object.keys(extra.breakdown).length === 0 && <li>(sin movimientos)</li>}
          </ul>
        </div>
      </Card>
    </div>
  );
}
