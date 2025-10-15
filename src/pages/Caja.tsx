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

type Row = {
  id: string;
  ts: any;
  seller: any;
  member: { id: string };
  itemType: "MENU" | "VEGGIE";
  destination: { mode: "COMEDOR" | "VIANDA"; table: string | null };
  allowDouble: boolean;
  voided: boolean;
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

  // Datos parseados
  const [memberId, setMemberId] = useState("");
  const [order, setOrder] = useState<{
    itemType: "MENU" | "VEGGIE";
    dest: { mode: "COMEDOR" | "VIANDA"; table: string | null };
  } | null>(null);

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
  useEffect(() => listenTodaySales(setRows), []);

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
      confirmIfReady(false); // auto-confirmar
    } catch (e: any) {
      setMsg(e.message); beep(false);
    }
  }

  // Confirmar venta
  async function confirmIfReady(allowDouble: boolean) {
    if (!user || !order || !memberId) return;
    setMsg(""); setDupInfo({ needed: false, message: "" });

    try {
      await ensureDaySettings();
      await createSaleTx({
        seller: { uid: user.uid, email: user.email ?? "", name: user.displayName ?? "" },
        memberId,
        itemType: order.itemType,
        dest: order.dest,
        allowDouble
      });
      beep(true);
      // limpiar y volver a socio
      setMemberInput(""); setOrderInput(""); setMemberId(""); setOrder(null);
      socioRef.current?.focus();
    } catch (e: any) {
      const m = String(e.message || e);
      if (m.toLowerCase().includes("ya tiene una compra")) {
        setDupInfo({ needed: true, message: m }); // pedir autorización de doble compra
      } else {
        setMsg(m); beep(false);
      }
      pedidoRef.current?.focus();
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
  }, [dupInfo.needed, memberId, order]);

  // Listado: acciones
  async function anular(id: string) {
    try { await voidSaleTx(id, true, "Anulada por administrativo"); }
    catch (e: any) { setMsg(e.message || String(e)); }
  }

  async function editar(r: Row) {
    const nuevoTipo = prompt("Tipo (MENU/VEGGIE):", r.itemType)?.toUpperCase();
    if (!nuevoTipo || (nuevoTipo !== "MENU" && nuevoTipo !== "VEGGIE")) return;

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
                <button className="button" onClick={() => confirmIfReady(true)}>
                  Permitir y confirmar (F2)
                </button>
                <button
                  className="button outline"
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
              disabled={!ready}
              onClick={() => confirmIfReady(false)}
            >
              Confirmar venta
            </button>
            <button
              className="button outline"
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
      <div style={{ position: "sticky", top: 64, alignSelf: "start" }}>
        <Card title={`Resumen hoy ${todayKey()}`}>
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
                {rows.map((r) => (
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
                          >
                            Editar
                          </button>
                          <button
                            className="button outline"
                            onClick={() => anular(r.id)}
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
