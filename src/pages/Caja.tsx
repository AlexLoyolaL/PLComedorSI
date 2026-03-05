import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../state/AuthContext";
import { parseMemberQR, parseOrderQR } from "../lib/parsers";
import {
  createSaleTx,
  ensureDaySettings,
  todayKey,
  listenTodaySales,
  voidSaleTx,
  updateSaleTx,
} from "../lib/sales";
import { Card } from "../ui/Card";
import { doc, onSnapshot, collection } from "firebase/firestore";
import { db } from "../firebase";

type Row = {
  id: string;
  ts: any;
  seller: any;
  member: { id: string };
  itemType: "MENU" | "VEGGIE" | "CELIACO";
  destination: { mode: "COMEDOR" | "VIANDA"; table: string | null };
  allowDouble: boolean;
  voided: boolean;
  manual?: boolean;          // <- NUEVO: marca cargas desde AdminViandas
};

type OrderData = {
  itemType: "MENU" | "VEGGIE" | "CELIACO";
  dest: { mode: "COMEDOR" | "VIANDA"; table: string | null };
};

// Helper: el lector USB suele mandar \r o \n al final
function hasEnter(s: string) {
  return /\r|\n/.test(s);
}

export default function Caja() {
  const { user } = useAuth();

  // Inputs crudos (lo que "tipea" el lector)
  const [memberInput, setMemberInput] = useState("");
  const [orderInput, setOrderInput] = useState("");

  const [limits, setLimits] = useState<{
    MENU: number | null;
    VEGGIE: number | null;
    CELIACO: number | null;
  }>({
    MENU: null,
    VEGGIE: null,
    CELIACO: null,
  });

  // Datos parseados
  const [memberId, setMemberId] = useState("");
  const [order, setOrder] = useState<OrderData | null>(null);

  // --- NUEVO: Control de carga y bloqueos de tiempo ---
  const [isLoading, setIsLoading] = useState(false);
  const lastScansRef = useRef<Map<string, number>>(new Map());

  // Duplicado: solo mostramos si hace falta
  const [dupInfo, setDupInfo] = useState<{ needed: boolean; message: string }>(
    { needed: false, message: "" }
  );

  const [msg, setMsg] = useState("");

  const socioRef = useRef<HTMLInputElement>(null);
  const pedidoRef = useRef<HTMLInputElement>(null);

  const ready = useMemo(() => !!memberId && !!order, [memberId, order]);

  // Listado en vivo
  const [rows, setRows] = useState<Row[]>([]);
  const [searchSocio, setSearchSocio] = useState("");
  const [manualAdds, setManualAdds] = useState<any[]>([]);

  useEffect(() => listenTodaySales(setRows), []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "adminAdds"), (snap) => {
      const today = todayKey();
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) }))
        .filter((r) => r.dateKey === today);

      setManualAdds(list);
    });

    return () => unsub();
  }, []);

  const filteredRows = useMemo(() => {
    // siempre escondemos las ventas manuales
    const base = rows.filter((r) => !r.manual);

    const q = searchSocio.trim().toLowerCase();
    if (!q) return base;

    return base.filter((r) => {
      const id = (r.member?.id ?? "").toLowerCase();
      return id.includes(q);
    });
  }, [rows, searchSocio]);

  const viandaCounts = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          // solo contamos ventas reales de Caja (no manuales)
          if (!r.voided && !r.manual) {
            if (
              r.itemType === "MENU" ||
              r.itemType === "VEGGIE" ||
              r.itemType === "CELIACO"
            ) {
              acc[r.itemType] = (acc[r.itemType] ?? 0) + 1;
            }
          }
          return acc;
        },
        {
          MENU: 0,
          VEGGIE: 0,
          CELIACO: 0,
        } as Record<"MENU" | "VEGGIE" | "CELIACO", number>
      ),
    [rows]
  );

  const adminCounts = useMemo(
    () =>
      manualAdds.reduce(
        (acc, r) => {
          const t = (r.itemType as "MENU" | "VEGGIE" | "CELIACO") || "MENU";
          const q = Number(r.qty) || 0;
          if (t === "MENU" || t === "VEGGIE" || t === "CELIACO") {
            acc[t] = (acc[t] ?? 0) + q;
          }
          return acc;
        },
        {
          MENU: 0,
          VEGGIE: 0,
          CELIACO: 0,
        } as Record<"MENU" | "VEGGIE" | "CELIACO", number>
      ),
    [manualAdds]
  );

  const totalUsadas: Record<"MENU" | "VEGGIE" | "CELIACO", number> = {
    MENU: viandaCounts.MENU + adminCounts.MENU,
    VEGGIE: viandaCounts.VEGGIE + adminCounts.VEGGIE,
    CELIACO: viandaCounts.CELIACO + adminCounts.CELIACO,
  };

  const remainingViandas: Record<"MENU" | "VEGGIE" | "CELIACO", number | null> = {
    MENU:
      limits.MENU != null ? Math.max(limits.MENU - totalUsadas.MENU, 0) : null,
    VEGGIE:
      limits.VEGGIE != null ? Math.max(limits.VEGGIE - totalUsadas.VEGGIE, 0) : null,
    CELIACO:
      limits.CELIACO != null ? Math.max(limits.CELIACO - totalUsadas.CELIACO, 0) : null,
  };

  useEffect(() => {
    const ref = doc(db, "settings_day", todayKey());
    const unsub = onSnapshot(ref, (snap) => {
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

  // Foco inicial en Socio
  useEffect(() => { socioRef.current?.focus(); }, []);

  // Sonidos (éxito / error)
  function beep(ok = true) {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = "sine"; o.frequency.value = ok ? 880 : 200;
      o.connect(g); g.connect(ctx.destination); g.gain.value = 0.08;
      o.start(); setTimeout(() => { o.stop(); ctx.close(); }, ok ? 120 : 220);
    } catch {}
  }

  // Paso 1: Socio
  function handleSocioEnter() {
    try {
      const { memberId } = parseMemberQR(memberInput);
      setMemberId(memberId);
      setMsg("");
      pedidoRef.current?.focus();
      pedidoRef.current?.select?.();
    } catch (e: any) {
      setMsg(e.message); beep(false);
    }
  }

  // Paso 2: Pedido (parsea y confirma)
  function handlePedidoEnter() {
    try {
      const p = parseOrderQR(orderInput);
      setOrder(p);
      setMsg("");

      // Usamos el pedido recién leído para confirmar de una
      confirmIfReady(false, p); // auto-confirmar
    } catch (e: any) {
      setMsg(e.message); beep(false);
    }
  }

  // Confirmar venta
  async function confirmIfReady(
    allowDouble: boolean,
    orderOverride?: {
      itemType: "MENU" | "VEGGIE" | "CELIACO";
      dest: { mode: "COMEDOR" | "VIANDA"; table: string | null };
    }
  ) {
    if (isLoading) return; // Evita el "clic-clic-clic" desesperado

    const currentOrder = orderOverride ?? order;

    if (!user || !currentOrder || !memberId) return;
    setMsg("");
    setDupInfo({ needed: false, message: "" });

    // --- NUEVO: Validación local de 30 segundos ---
    const now = Date.now();
    const lastScanTime = lastScansRef.current.get(memberId) || 0;
    
    // Si no estamos forzando (allowDouble) y pasaron menos de 30 segundos (30000ms)
    if (!allowDouble && (now - lastScanTime < 30000)) {
      setDupInfo({
        needed: true,
        message: `Epa, esto ya se cargó hace menos de 30 segundos, ¿estás seguro?`
      });
      beep(false);
      return; 
    }

    // Validación de límite de VIANDAS por tipo
    if (currentOrder.dest.mode === "VIANDA") {
      const tipo = currentOrder.itemType; 
      const limit = limits[tipo];
      const usadas = totalUsadas[tipo] ?? 0;

      if (typeof limit === "number" && limit >= 0 && usadas >= limit) {
        setMsg(`No hay más raciones disponibles para ${tipo} hoy.`);
        beep(false);
        return;
      }
    }

    setIsLoading(true); // Bloqueamos la UI

    try {
      await ensureDaySettings();
      await createSaleTx({
        seller: { uid: user.uid, email: user.email ?? "", name: user.displayName ?? "" },
        memberId,
        itemType: currentOrder.itemType,
        dest: currentOrder.dest,
        allowDouble,
      });

      // --- NUEVO: Registramos la hora del éxito para este socio ---
      lastScansRef.current.set(memberId, Date.now());

      beep(true);
      // limpiar y volver a socio
      setMemberInput("");
      setOrderInput("");
      setMemberId("");
      setOrder(null);
      socioRef.current?.focus();
    } catch (e: any) {
      const m = String(e.message || e);
      if (m.toLowerCase().includes("ya tiene una compra")) {
        setDupInfo({ needed: true, message: m });
      } else {
        setMsg(m);
      }
      beep(false);
    } finally {
      setIsLoading(false); // Liberamos la UI pase lo que pase
    }
  }

  // Atajo F2 para confirmar con doble compra cuando aparece el banner
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (dupInfo.needed && e.key === "F2") {
        e.preventDefault(); confirmIfReady(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dupInfo.needed, memberId, order, isLoading]); // Agregué isLoading a las dependencias por las dudas

  // Listado: acciones
  async function anular(id: string) {
    try { await voidSaleTx(id, true, "Anulada por administrativo"); }
    catch (e: any) { setMsg(e.message || String(e)); }
  }

  async function editar(r: Row) {
    const nuevoTipo = prompt("Tipo (MENU/VEGGIE/CELIACO):", r.itemType)?.toUpperCase();
    if (!nuevoTipo || (nuevoTipo !== "MENU" && nuevoTipo !== "VEGGIE" && nuevoTipo !== "CELIACO")) return;

    const modo = prompt("Destino (COMEDOR/VIANDA):", r.destination.mode)?.toUpperCase();
    if (!modo || (modo !== "COMEDOR" && modo !== "VIANDA")) return;

    let mesa: string | null = r.destination.table;
    if (modo === "COMEDOR") {
      mesa = prompt("Mesa (ej. MESA 07):", r.destination.table ?? "")?.toUpperCase() || "";
      if (!mesa) return;
    } else {
      mesa = null;
    }

    try {
      await updateSaleTx({ saleId: r.id, newItemType: nuevoTipo as any, newDest: { mode: modo as any, table: mesa } });
    } catch (e: any) {
      alert(e.message || String(e));
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(540px, 1fr) minmax(540px, 1fr)",
        gap: 16,
      }}
    >
      {/* Columna izquierda: flujo de venta */}
      <div style={{ display: "grid", gap: 16 }}>
        {/* 1) Socio */}
        <Card title="1) Escanear carnet">
          <div style={{ display: "grid", gap: 8 }}>
            <input
              ref={socioRef}
              className="input"
              disabled={isLoading}
              placeholder="Posicioná el cursor aquí y escaneá el QR del socio"
              value={memberInput}
              onChange={(e) => {
                const v = e.target.value;
                setMemberInput(v);
                if (hasEnter(v)) {
                  const clean = v.replace(/[\r\n]+/g, " ").trim();
                  setMemberInput(clean);
                  handleSocioEnter();
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "NumpadEnter") {
                  e.preventDefault();
                  handleSocioEnter();
                }
              }}
            />
            <div>Socio: <b>{memberId || "-"}</b></div>
          </div>
        </Card>

        {/* 2) Pedido */}
        <Card title="2) Escanear pedido (comida + destino)">
          <div style={{ display: "grid", gap: 8 }}>
            <input
              ref={pedidoRef}
              className="input"
              disabled={isLoading}
              placeholder="Luego escaneá el QR de MENU/VEGGIE + MESA/VIANDA"
              value={orderInput}
              onChange={(e) => {
                const v = e.target.value;
                setOrderInput(v);
                if (hasEnter(v)) {
                  const clean = v.replace(/[\r\n]+/g, " ").trim();
                  setOrderInput(clean);
                  handlePedidoEnter(); // parsea y confirma
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "NumpadEnter") {
                  e.preventDefault();
                  handlePedidoEnter(); // un solo Enter confirma
                }
              }}
            />
            <div>
              Pedido:{" "}
              <b>
                {order
                  ? `${order.itemType} • ${order.dest.mode}${
                      order.dest.table ? " • " + order.dest.table : ""
                    }`
                  : "-"}
              </b>
            </div>
          </div>
        </Card>

        {/* 3) Confirmar */}
        <Card
          title="3) Confirmar"
          right={<span style={{ color: "#9aa4c0" }}>Enter en “Pedido” confirma.</span>}
        >
          {dupInfo.needed ? (
            <div
              className="panel"
              style={{
                borderColor: "var(--warn)",
                background: "rgba(245,158,11,.08)",
                marginBottom: 10,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                Doble compra detectada
              </div>
              <div style={{ color: "var(--muted)", marginBottom: 10 }}>
                {dupInfo.message}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button 
                  className="button" 
                  disabled={isLoading}
                  onClick={() => confirmIfReady(true)}
                >
                  {isLoading ? "Procesando..." : "Permitir y confirmar (F2)"}
                </button>
                <button
                  className="button outline"
                  disabled={isLoading}
                  onClick={() => setDupInfo({ needed: false, message: "" })}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <div style={{ color: "var(--muted)" }}>
              Si hay duplicado se mostrará un aviso para autorizar la doble compra.
            </div>
          )}

          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button
              className="button"
              disabled={!ready || isLoading}
              onClick={() => confirmIfReady(false)}
            >
              {isLoading ? "Procesando..." : "Confirmar venta"}
            </button>
            <button
              className="button outline"
              disabled={isLoading}
              onClick={() => {
                setMemberInput("");
                setOrderInput("");
                setMemberId("");
                setOrder(null);
                setMsg("");
                setDupInfo({ needed: false, message: "" });
                socioRef.current?.focus();
              }}
            >
              Limpiar
            </button>
          </div>
          <div
            style={{
              marginTop: 8,
              color: msg ? "var(--danger)" : "inherit",
              minHeight: 20,
            }}
          >
            {msg}
          </div>
        </Card>
      </div>

      {/* Columna derecha: resumen (sticky) */}
      <div
        style={{
          position: "sticky",
          top: 64,
          alignSelf: "start",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {/* Contador de viandas bien compacto */}
        <Card title="Ventas">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 12,
              fontWeight: 600, // para las etiquetas en negrita
              textAlign: "center",
            }}
          >
            <div style={{ flex: 1, textAlign: "left" }}>
              MENU:&nbsp;
              <span style={{ fontWeight: 400 }}>
                {totalUsadas.MENU}
                {limits.MENU != null
                  ? ` / ${limits.MENU} (quedan ${remainingViandas.MENU})`
                  : " / –"}
              </span>
            </div>

            <div style={{ flex: 1, textAlign: "center" }}>
              VEGGIE:&nbsp;
              <span style={{ fontWeight: 400 }}>
                {totalUsadas.VEGGIE}
                {limits.VEGGIE != null
                  ? ` / ${limits.VEGGIE} (quedan ${remainingViandas.VEGGIE})`
                  : " / –"}
              </span>
            </div>

            <div style={{ flex: 1, textAlign: "right" }}>
              CELIACO:&nbsp;
              <span style={{ fontWeight: 400 }}>
                {totalUsadas.CELIACO}
                {limits.CELIACO != null
                  ? ` / ${limits.CELIACO} (quedan ${remainingViandas.CELIACO})`
                  : " / –"}
              </span>
            </div>
          </div>
        </Card>

        <Card title={`Resumen hoy ${todayKey()}`}>
          <div style={{ marginBottom: 8 }}>
            <input
              type="text"
              placeholder="Buscar socio por nombre o DNI..."
              value={searchSocio}
              onChange={(e) => setSearchSocio(e.target.value)}
              style={{
                width: "100%",
                padding: 6,
                fontSize: 14,
                boxSizing: "border-box",
              }}
            />
          </div>
          <p style={{ marginTop: 0, color: "var(--muted)" }}>
            Listado en vivo (últimas 100). Podés editar rápido o anular.
          </p>
          <div style={{ maxHeight: "70vh", overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Socio</th>
                  <th>Tipo</th>
                  <th>Destino</th>
                  <th>Mesa</th>
                  <th>Vendedor</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => (
                  <tr key={r.id} style={{ opacity: r.voided ? 0.5 : 1 }}>
                    <td>{r.ts?.toDate ? r.ts.toDate().toLocaleTimeString() : ""}</td>
                    <td>{r.member?.id}</td>
                    <td>{r.itemType}</td>
                    <td>{r.destination?.mode}</td>
                    <td>{r.destination?.table ?? "-"}</td>
                    <td>{r.seller?.email}</td>
                    <td style={{ textAlign: "right" }}>
                      {!r.voided ? (
                        <>
                          <button
                            className="button ghost"
                            onClick={() => editar(r)}
                            style={{ marginRight: 8 }}
                            disabled={isLoading}
                          >
                            Editar
                          </button>
                          <button
                            className="button outline"
                            onClick={() => anular(r.id)}
                            disabled={isLoading}
                          >
                            Anular
                          </button>
                        </>
                      ) : (
                        <span className="badge">Anulada</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}