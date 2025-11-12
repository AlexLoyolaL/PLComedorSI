import { useState, useEffect } from "react";
import { doc, onSnapshot, setDoc, collection } from "firebase/firestore";
import { db } from "../firebase";
import { Card } from "../ui/Card";
import { addManualViandas, todayKey, listenTodaySales } from "../lib/sales";
import { useAuth } from "../state/AuthContext";
import RequireRole from "../components/RequireRole"; // el que permite allowAny
import type { ViandaConcept } from "../lib/sales";


type Row = {
  id: string;
  ts: any;
  seller: any;
  member: { id: string };
  itemType: "MENU" | "VEGGIE" | "CELIACO";
  destination: { mode: "COMEDOR" | "VIANDA"; table: string | null };
  allowDouble: boolean;
  voided: boolean;
};


export default function AdminViandasPage() {
  return (
    <RequireRole allowAny={["admin"]}>
      <AdminViandasInner />
    </RequireRole>
  );
}

function AdminViandasInner() {
  const { user } = useAuth();

  // NUEVOS estados que faltaban
  const [qty, setQty] = useState<number>(1);
  const [concept, setConcept] = useState<ViandaConcept>("PERSONAL");

  const [itemType, setItemType] = useState<"MENU" | "VEGGIE" | "CELIACO">("MENU");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  // Mostrar totales y desglose actual (en vivo)
  const [extra, setExtra] = useState<{ total: number; breakdown: Record<string, number> }>({
    total: 0,
    breakdown: {},
  });
  
  const [limits, setLimits] = useState<{
    MENU: number | null;
    VEGGIE: number | null;
    CELIACO: number | null;
  }>({
    MENU: null,
    VEGGIE: null,
    CELIACO: null,
  });

  const [totalMenu, setTotalMenu] = useState<number>(0);
  const [totalVeggie, setTotalVeggie] = useState<number>(0);
  const [totalCeliaco, setTotalCeliaco] = useState<number>(0);


  const [manualAdds, setManualAdds] = useState<any[]>([]);

  

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "adminAdds"), (snap) => {
      const today = todayKey();
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) }))
        .filter((r) => r.dateKey === today)
        .sort((a, b) => {
          const ta = a.ts?.toDate ? a.ts.toDate().getTime() : 0;
          const tb = b.ts?.toDate ? b.ts.toDate().getTime() : 0;
          return tb - ta; // más recientes primero
        });

      setManualAdds(list);
    });

    return () => unsub();
  }, []);

  useEffect(() => {
    return listenTodaySales(setRows);
  }, []);

  // leer límites desde settings_day
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "settings_day", todayKey()), (snap) => {
      const data = (snap.data() as any) || {};
      const ls = data.limits || {};

      setLimits({
        MENU: typeof ls.MENU === "number" ? ls.MENU : null,
        VEGGIE: typeof ls.VEGGIE === "number" ? ls.VEGGIE : null,
        CELIACO: typeof ls.CELIACO === "number" ? ls.CELIACO : null,
      });
    });

    return () => unsub();
  }, []);

    // Totales por tipo: ventas del día + cargas manuales
  useEffect(() => {
    let tm = 0, tv = 0, tc = 0;

    // 1) Ventas "normales" (Caja)
    for (const r of rows) {
      if (r.voided) continue;

      if (r.itemType === "MENU") {
        tm += 1;
      } else if (r.itemType === "VEGGIE") {
        tv += 1;
      } else if (r.itemType === "CELIACO") {
        tc += 1;
      }
    }

    // 2) Cargas manuales (adminAdds)
    for (const r of manualAdds) {
      const q = Number(r.qty) || 0;
      if (r.itemType === "MENU") {
        tm += q;
      } else if (r.itemType === "VEGGIE") {
        tv += q;
      } else if (r.itemType === "CELIACO") {
        tc += q;
      }
    }

    setTotalMenu(tm);
    setTotalVeggie(tv);
    setTotalCeliaco(tc);
  }, [rows, manualAdds]);


    // Resumen "Cargas manuales" (Total extra + breakdown)
  useEffect(() => {
    const breakdown: Record<string, number> = {};
    let total = 0;

    for (const r of manualAdds) {
      const qty = Number(r.qty) || 0;
      const key = `${r.concept || "SIN_CONCEPTO"}_${r.itemType || "SIN_TIPO"}`;
      breakdown[key] = (breakdown[key] ?? 0) + qty;
      total += qty;
    }

    setExtra({ total, breakdown });
  }, [manualAdds]);

  function handleLimitChange(
    type: "MENU" | "VEGGIE" | "CELIACO",
    value: string
  ) {
    const num = value === "" ? null : Number(value);
    const newLimits = {
      ...limits,
      [type]: Number.isFinite(num as number) ? (num as number) : null,
    };

    setLimits(newLimits);

    const ref = doc(db, "settings_day", todayKey());
    setDoc(ref, { limits: newLimits }, { merge: true });
  }

  // IMPORTANTE: el nombre tiene que coincidir con el botón (handleManualAdd)
  async function handleManualAdd() {
    if (!user) return;
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) {
      setMsg("Cantidad inválida");
      return;
    }

    try {
      await addManualViandas({
        qty: q,
        concept,
        itemType,
        note,
        seller: {
          uid: user.uid,
          email: user.email || "",
          name: user.displayName || "",
        },
      });
      setMsg(`Se agregaron ${q} viandas (${concept.replace("_", " ")})`);
      setQty(1);
      setNote("");
      setItemType("MENU");
    } catch (e: any) {
      setMsg(e?.message || String(e));
    }
  }

  async function handleManualUpdate() {
    if (!user || !editingId) return;
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) {
      setMsg("Cantidad inválida");
      return;
    }

    try {
      const ref = doc(db, "adminAdds", editingId);
      await setDoc(ref, { qty: q, concept, itemType, note }, { merge: true });
      setMsg(`Se actualizó la carga manual (${concept.replace("_", " ")})`);
      setEditingId(null);
      setQty(1);
      setNote("");
      setItemType("MENU");
    } catch (e: any) {
      setMsg(e?.message || String(e));
    }
  }

  function handleEditRow(r: any) {
    setEditingId(r.id || null);
    setQty(Number(r.qty) || 1);
    setConcept((r.concept || "PERSONAL") as ViandaConcept);
    setItemType((r.itemType || "MENU") as "MENU" | "VEGGIE" | "CELIACO");
    setNote(r.note || "");
    setMsg("Editando carga manual seleccionada");
  }

  function handleCancelEdit() {
    setEditingId(null);
    setQty(1);
    setConcept("PERSONAL");
    setItemType("MENU");
    setNote("");
    setMsg("");
  }


  return (
    <div className="grid cols-1">
      <Card title="Cargar viandas manuales (solo Admin)">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 16,
            alignItems: "end",
          }}
        >
          <div>
            <div style={{ marginBottom: 4 }}>Cantidad</div>
            <input
              type="number"
              className="input"
              min={1}
              value={qty}
              onChange={(e) => setQty(Number(e.target.value))}
            />
          </div>

          <div>
            <div style={{ marginBottom: 4 }}>Concepto</div>
            <select
              className="input"
              value={concept}
              onChange={(e) => setConcept(e.target.value as ViandaConcept)}
            >
              <option value="PERSONAL">Personal</option>
              <option value="DESAYUNO">Desayuno</option>
              <option value="CENTRO_JUBILADOS">Centro jubilados</option>
              <option value="EVENTOS">Eventos</option>
              <option value="VIANDA_CONGELADA">Vianda congelada</option>
            </select>
          </div>

          <div>
            <div style={{ marginBottom: 4 }}>Tipo de vianda</div>
            <select
              className="input"
              value={itemType}
              onChange={(e) =>
                setItemType(e.target.value as "MENU" | "VEGGIE" | "CELIACO")
              }
            >
              <option value="MENU">Menú</option>
              <option value="VEGGIE">Veggie</option>
              <option value="CELIACO">Celiaco</option>
            </select>
          </div>

          <div style={{ gridColumn: "1 / -1" }}>
            <div style={{ marginBottom: 4 }}>Reporte / descripción</div>
            <textarea
              className="input"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ej.: Evento aniversario, viandas congeladas para stock, etc."
            />
          </div>

          <div style={{ gridColumn: "1 / -1" }}>
            <button
              className="button"
              onClick={editingId ? handleManualUpdate : handleManualAdd}
            >
              {editingId ? "Guardar cambios" : "Registrar carga manual"}
            </button>
            {editingId && (
              <button
                type="button"
                className="button"
                style={{ marginLeft: 8, opacity: 0.8 }}
                onClick={handleCancelEdit}
              >
                Cancelar edición
              </button>
            )}
            {msg && (
              <div style={{ marginTop: 8, color: "var(--muted)" }}>
                {msg}
              </div>
            )}
          </div>

        </div>

        {msg && (
          <div
            className="panel"
            style={{
              marginTop: 12,
              borderColor: msg.startsWith("Se agregaron")
                ? "var(--ok)"
                : "var(--danger)",
            }}
          >
            {msg}
          </div>
        )}
      </Card>
      <Card title="Límites diarios por tipo">
        <div className="panel">
          {/* MENU */}
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 12, alignItems: "center", marginBottom: 8 }}>
            <div>
              <div>Menú</div>
              <small>Incluye comedor + vianda</small>
            </div>
            <div>
              <label style={{ display: "block", marginBottom: 4 }}>Límite diario</label>
              <input
                type="number"
                min={0}
                className="input"
                value={limits.MENU ?? ""}
                onChange={(e) => handleLimitChange("MENU", e.target.value)}
                style={{ maxWidth: 140 }}
              />
            </div>
            <div>
              <div>Vendidos: {totalMenu}</div>
              {limits.MENU != null && (
                <div>Quedan: {Math.max(limits.MENU - totalMenu, 0)}</div>
              )}
            </div>
          </div>

          {/* VEGGIE */}
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 12, alignItems: "center", marginBottom: 8 }}>
            <div>
              <div>Veggie</div>
              <small>Incluye comedor + vianda</small>
            </div>
            <div>
              <label style={{ display: "block", marginBottom: 4 }}>Límite diario</label>
              <input
                type="number"
                min={0}
                className="input"
                value={limits.VEGGIE ?? ""}
                onChange={(e) => handleLimitChange("VEGGIE", e.target.value)}
                style={{ maxWidth: 140 }}
              />
            </div>
            <div>
              <div>Vendidos: {totalVeggie}</div>
              {limits.VEGGIE != null && (
                <div>Quedan: {Math.max(limits.VEGGIE - totalVeggie, 0)}</div>
              )}
            </div>
          </div>

          {/* CELIACO */}
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 12, alignItems: "center" }}>
            <div>
              <div>Celiaco</div>
              <small>Incluye comedor + vianda</small>
            </div>
            <div>
              <label style={{ display: "block", marginBottom: 4 }}>Límite diario</label>
              <input
                type="number"
                min={0}
                className="input"
                value={limits.CELIACO ?? ""}
                onChange={(e) => handleLimitChange("CELIACO", e.target.value)}
                style={{ maxWidth: 140 }}
              />
            </div>
            <div>
              <div>Vendidos: {totalCeliaco}</div>
              {limits.CELIACO != null && (
                <div>Quedan: {Math.max(limits.CELIACO - totalCeliaco, 0)}</div>
              )}
            </div>
          </div>
        </div>
      </Card>


      <Card title={`Resumen hoy ${todayKey()}`}>
        

        <div className="panel" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Cargas manuales</div>
          <div>
            Total extra: <b>{extra.total}</b>
          </div>
          <ul style={{ marginTop: 8 }}>
            {Object.entries(extra.breakdown).map(([k, v]) => (
              <li key={k}>
                {k.replace("_", " ")}: <b>{v}</b>
              </li>
            ))}
            {Object.keys(extra.breakdown).length === 0 && (
              <li>(sin movimientos)</li>
            )}
          </ul>

          {manualAdds.length > 0 && (
            <>
              <hr style={{ margin: "12px 0", borderColor: "#334" }} />
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Detalle de cargas de hoy
              </div>
              <table className="table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Hora</th>
                    <th>Concepto</th>
                    <th>Tipo</th>
                    <th>Cant.</th>
                    <th>Observaciones</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {manualAdds.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.ts?.toDate ? r.ts.toDate().toLocaleTimeString() : ""}
                      </td>
                      <td>{String(r.concept || "").replace("_", " ")}</td>
                      <td>{r.itemType || "-"}</td>
                      <td>{r.qty}</td>
                      <td>{r.note || ""}</td>
                      <td>
                        <button
                          type="button"
                          className="button"
                          style={{ fontSize: 11, padding: "2px 8px" }}
                          onClick={() => handleEditRow(r)}
                        >
                          Editar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>

              </table>
            </>
          )}
        </div>
      </Card> 
    </div>
  );
}   
