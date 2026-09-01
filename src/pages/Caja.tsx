import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../state/AuthContext";
import { parseOrderQR } from "../lib/parsers";
import {
  createSaleTx,
  ensureDaySettings,
  todayKey,
  listenTodaySales,
  voidSaleTx,
  updateSaleTx,
} from "../lib/sales";
import { Card } from "../ui/Card";
import { doc, onSnapshot, collection, query, orderBy } from "firebase/firestore";
import { db } from "../firebase";
import { getFunctions, httpsCallable } from "firebase/functions";
import { resolveMemberDni } from "../lib/memberId";

type Row = {
  id: string;
  ts: any;
  seller: any;
  member: { id: string };
  itemType: "MENU" | "VEGGIE" | "CELIACO";
  destination: { mode: "COMEDOR" | "VIANDA"; table: string | null };
  allowDouble: boolean;
  voided: boolean;
  manual?: boolean;
  isSubsidized?: boolean;
  paymentMethod?: "EFECTIVO" | "MP" | "SUBVENCIONADO" | "LOTE_PREPAGO"; 
};

type OrderData = {
  itemType: "MENU" | "VEGGIE" | "CELIACO";
  dest: { mode: "COMEDOR" | "VIANDA"; table: string | null };
};

function hasEnter(s: string) {
  return /\r|\n/.test(s);
}

export default function Caja() {
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState<"caja_rapida" | "venta_lotes">("caja_rapida");

  const [memberInput, setMemberInput] = useState("");
  const [orderInput, setOrderInput] = useState("");
  const [paymentInput, setPaymentInput] = useState(""); 

  const [limits, setLimits] = useState<{ MENU: number | null; VEGGIE: number | null; CELIACO: number | null; }>({ MENU: null, VEGGIE: null, CELIACO: null });

  const [memberId, setMemberId] = useState("");
  const [order, setOrder] = useState<OrderData | null>(null);
  const [isSubsidized, setIsSubsidized] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<"EFECTIVO" | "MP" | "SUBVENCIONADO" | "LOTE_PREPAGO" | null>(null); 
  
  const [memberBundleRemaining, setMemberBundleRemaining] = useState<number | null>(null); 

  const [isLoading, setIsLoading] = useState(false);
  const lastScansRef = useRef<Map<string, number>>(new Map());
  const [dupInfo, setDupInfo] = useState<{ needed: boolean; message: string }>({ needed: false, message: "" });
  const [msg, setMsg] = useState("");

  const socioRef = useRef<HTMLInputElement>(null);
  const pedidoRef = useRef<HTMLInputElement>(null);
  const pagoRef = useRef<HTMLInputElement>(null); 

  const ready = useMemo(() => !!memberId && !!order, [memberId, order]);

  const [rows, setRows] = useState<Row[]>([]);
  const [manualAdds, setManualAdds] = useState<any[]>([]);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  const [searchSocio, setSearchSocio] = useState("");
  const [filterTable, setFilterTable] = useState("");
  const [filterSubsidized, setFilterSubsidized] = useState(false);

  // Precio por vianda del lote mensual. Actualizalo acá cuando cambie el
  // valor del menú para que el total a cobrar del lote se siga calculando solo.
  const PRECIO_VIANDA_LOTE = 3000;

  const [loteDni, setLoteDni] = useState("");
  const [cantidadViandas, setCantidadViandas] = useState(20);
  const [montoPagado, setMontoPagado] = useState(String(20 * PRECIO_VIANDA_LOTE));
  const [loteLoading, setLoteLoading] = useState(false);
  const [generatedLink, setGeneratedLink] = useState("");
  const [bundleSales, setBundleSales] = useState<any[]>([]);

  // Nombre y apellido de los socios subsidiados (Gabinete Social), para
  // mostrarlos junto al DNI en el listado de ventas en vez de solo el número.
  const [subsidizedNames, setSubsidizedNames] = useState<Record<string, { name: string; lastName: string }>>({});

  useEffect(() => {
    const goOnline = () => setIsOnline(true); 
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline); 
    window.addEventListener('offline', goOffline);
    return () => { 
      window.removeEventListener('online', goOnline); 
      window.removeEventListener('offline', goOffline); 
    };
  }, []);

  useEffect(() => listenTodaySales(setRows), []);

  // Recalcula el total a cobrar del lote cada vez que cambia la cantidad de
  // viandas elegida, en base al precio vigente por vianda.
  useEffect(() => {
    setMontoPagado(String(cantidadViandas * PRECIO_VIANDA_LOTE));
  }, [cantidadViandas]);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "subsidized_members"), (snap) => {
      const map: Record<string, { name: string; lastName: string }> = {};
      snap.forEach((d) => {
        const data = d.data() as any;
        map[d.id] = { name: data?.name ?? "", lastName: data?.lastName ?? "" };
      });
      setSubsidizedNames(map);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "adminAdds"), (snap) => {
      const today = todayKey();
      setManualAdds(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })).filter((r) => r.dateKey === today));
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const qBundle = query(collection(db, "bundle_sales"), orderBy("fecha", "desc"));
    const unsub = onSnapshot(qBundle, snap => {
      const today = todayKey();
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }) as any);
      const todayList = list.filter(r => r.dateKey === today || (r.fecha && new Date(r.fecha.toDate()).toLocaleDateString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" }) === today));
      setBundleSales(todayList);
    });
    return () => unsub();
  }, []);

  // --- NUEVO: SENSOR EN TIEMPO REAL (Reemplaza el getDoc estático) ---
  useEffect(() => {
    if (!memberId) {
      setMemberBundleRemaining(null);
      setIsSubsidized(false);
      return;
    }

    const unsubSub = onSnapshot(doc(db, "subsidized_members", memberId), (snap) => {
      setIsSubsidized(snap.exists() && snap.data()?.active === true);
    });

    const unsubMember = onSnapshot(doc(db, "members", memberId), (snap) => {
      if (snap.exists()) {
        const bundle = snap.data()?.active_bundle;
        const now = new Date(); 
        const expires = bundle?.expiresAt?.toDate ? bundle.expiresAt.toDate() : null;
        if (bundle && bundle.remaining > 0 && (!expires || now < expires)) {
          setMemberBundleRemaining(bundle.remaining);
        } else {
          setMemberBundleRemaining(null);
        }
      } else {
        setMemberBundleRemaining(null);
      }
    });

    return () => { unsubSub(); unsubMember(); };
  }, [memberId]);

  // --- NUEVO: PLC AUTO-DISPARADOR (Evita la condición de carrera del escáner) ---
  useEffect(() => {
    if (order && !paymentMethod && !isLoading) {
      if (isSubsidized) {
        setPaymentMethod("SUBVENCIONADO");
        confirmIfReady(false, order, "SUBVENCIONADO");
      } else if (memberBundleRemaining !== null && memberBundleRemaining > 0) {
        setPaymentMethod("LOTE_PREPAGO");
        confirmIfReady(false, order, "LOTE_PREPAGO");
      }
    }
  }, [order, memberBundleRemaining, isSubsidized, paymentMethod, isLoading]);

  const filteredRows = useMemo(() => {
    let base = rows.filter((r) => !r.manual);
    if (filterSubsidized) base = base.filter((r) => r.isSubsidized);
    if (filterTable) base = base.filter((r) => r.destination?.table === filterTable);
    const q = searchSocio.trim().toLowerCase();
    if (q) base = base.filter((r) => (r.member?.id ?? "").toLowerCase().includes(q));
    return base;
  }, [rows, searchSocio, filterSubsidized, filterTable]);

  const viandaCounts = useMemo(() => rows.reduce((acc, r) => {
    if (!r.voided && !r.manual && (r.itemType === "MENU" || r.itemType === "VEGGIE" || r.itemType === "CELIACO")) {
      acc[r.itemType] = (acc[r.itemType] ?? 0) + 1;
    }
    return acc;
  }, { MENU: 0, VEGGIE: 0, CELIACO: 0 } as Record<"MENU" | "VEGGIE" | "CELIACO", number>), [rows]);

  const adminCounts = useMemo(() => manualAdds.reduce((acc, r) => {
    const t = (r.itemType as "MENU" | "VEGGIE" | "CELIACO") || "MENU";
    const q = Number(r.qty) || 0;
    if (t === "MENU" || t === "VEGGIE" || t === "CELIACO") acc[t] = (acc[t] ?? 0) + q;
    return acc;
  }, { MENU: 0, VEGGIE: 0, CELIACO: 0 } as Record<"MENU" | "VEGGIE" | "CELIACO", number>), [manualAdds]);

  const totalUsadas: Record<"MENU" | "VEGGIE" | "CELIACO", number> = {
    MENU: viandaCounts.MENU + adminCounts.MENU, 
    VEGGIE: viandaCounts.VEGGIE + adminCounts.VEGGIE, 
    CELIACO: viandaCounts.CELIACO + adminCounts.CELIACO,
  };

  const remainingViandas: Record<"MENU" | "VEGGIE" | "CELIACO", number | null> = {
    MENU: limits.MENU != null ? Math.max(limits.MENU - totalUsadas.MENU, 0) : null,
    VEGGIE: limits.VEGGIE != null ? Math.max(limits.VEGGIE - totalUsadas.VEGGIE, 0) : null,
    CELIACO: limits.CELIACO != null ? Math.max(limits.CELIACO - totalUsadas.CELIACO, 0) : null,
  };

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "settings_day", todayKey()), (snap) => {
      const ls = (snap.data() as any)?.limits || {};
      setLimits({ MENU: typeof ls.MENU === "number" ? ls.MENU : null, VEGGIE: typeof ls.VEGGIE === "number" ? ls.VEGGIE : null, CELIACO: typeof ls.CELIACO === "number" ? ls.CELIACO : null });
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => { if (!isOnline) { e.preventDefault(); e.returnValue = "Hay ventas pendientes de sincronizar."; } };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isOnline]);

  useEffect(() => { if (activeTab === "caja_rapida") socioRef.current?.focus(); }, [activeTab]);

  function beep(ok = true) {
    try { 
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext; 
      const ctx = new Ctx(); 
      const o = ctx.createOscillator(); 
      const g = ctx.createGain(); 
      o.type = "sine"; 
      o.frequency.value = ok ? 880 : 200; 
      o.connect(g); 
      g.connect(ctx.destination); 
      g.gain.value = 0.08; 
      o.start(); 
      setTimeout(() => { o.stop(); ctx.close(); }, ok ? 120 : 220); 
    } catch {}
  }

  async function handleSocioEnter(scannedText: string) {
    if (!scannedText || scannedText.trim() === "") return;

    try {
      // resolveMemberDni usa la MISMA lógica que Gabinete Social para
      // traducir el carnet escaneado al DNI canónico (vía qr_mappings).
      // Es clave que ambas pantallas resuelvan igual, sino un socio puede
      // quedar cargado como subvencionado bajo una clave y buscado bajo otra.
      const finalDni = await resolveMemberDni(scannedText);

      if (!finalDni) {
        setMsg("❌ Vinculación cancelada o DNI inválido. Volvé a escanear.");
        beep(false);
        return;
      }

      setMemberId(finalDni);

      // Ya no frenamos el proceso con un await acá. El foco pasa al pedido instantáneamente.
      setTimeout(() => {
        pedidoRef.current?.focus();
        pedidoRef.current?.select?.();
      }, 50);

    } catch (e: any) {
      setMsg(e.message);
      beep(false);
      setIsSubsidized(false);
      setMemberBundleRemaining(null);
    }
  }

  function handlePedidoEnter() {
    try {
      const p = parseOrderQR(orderInput);
      setOrder(p); 
      setMsg("");
      // Mandamos foco a pago por defecto, pero si entra data del Lote en el sensor (useEffect),
      // el PLC auto-disparador se encarga de saltarse este paso y cobrar.
      setTimeout(() => pagoRef.current?.focus(), 50);
    } catch (e: any) { 
      setMsg(e.message); 
      beep(false); 
    }
  }

  function handlePagoEnter(scannedText: string) {
    if (!scannedText || scannedText.trim() === "") return;
    const clean = scannedText.trim().toUpperCase();
    let method: "EFECTIVO" | "MP" | null = null;
    if (clean.includes("EFECTIVO")) method = "EFECTIVO";
    else if (clean.includes("MP") || clean.includes("MERCADO")) method = "MP";

    if (method) { setPaymentMethod(method); setMsg(""); confirmIfReady(false, order!, method); } 
    else { setMsg("⚠️ QR inválido. Escaneá PAGO-EFECTIVO o PAGO-MP."); beep(false); setPaymentInput(""); }
  }

  async function confirmIfReady(allowDouble: boolean, orderOverride?: OrderData, paymentOverride?: "EFECTIVO" | "MP" | "SUBVENCIONADO" | "LOTE_PREPAGO") {
    if (isLoading) return;
    const currentOrder = orderOverride ?? order; 
    const finalPayment = paymentOverride ?? paymentMethod;
    if (!user || !currentOrder || !memberId) return;

    if (!isSubsidized && !finalPayment && memberBundleRemaining === null) { setMsg("Falta escanear el método de pago."); beep(false); pagoRef.current?.focus(); return; }

    setMsg(""); setDupInfo({ needed: false, message: "" });
    const now = Date.now(); 
    const lastScanTime = lastScansRef.current.get(memberId) || 0;
    if (!allowDouble && (now - lastScanTime < 30000)) { setDupInfo({ needed: true, message: `Doble compra detectada.` }); beep(false); return; }

    if (currentOrder.dest.mode === "VIANDA") {
      const tipo = currentOrder.itemType; 
      const limit = limits[tipo]; 
      const usadas = totalUsadas[tipo] ?? 0;
      if (typeof limit === "number" && limit >= 0 && usadas >= limit) { setMsg(`No hay más raciones para ${tipo}.`); beep(false); return; }
    }

    setIsLoading(true);
    try {
      await ensureDaySettings();
      await createSaleTx({ seller: { uid: user.uid, email: user.email ?? "", name: user.displayName ?? "" }, memberId, itemType: currentOrder.itemType, dest: currentOrder.dest, allowDouble, paymentMethod: finalPayment as any });
      lastScansRef.current.set(memberId, Date.now()); 
      beep(true);
      setMemberInput(""); setOrderInput(""); setPaymentInput(""); setMemberId(""); setOrder(null); setIsSubsidized(false); setPaymentMethod(null); setMemberBundleRemaining(null);
      setTimeout(() => socioRef.current?.focus(), 50);
    } catch (e: any) {
      const m = String(e.message || e); 
      if (m.toLowerCase().includes("ya tiene una compra")) setDupInfo({ needed: true, message: m }); 
      else setMsg(m); 
      beep(false);
    } finally { setIsLoading(false); }
  }

  useEffect(() => { 
    function onKey(e: KeyboardEvent) { if (dupInfo.needed && e.key === "F2") { e.preventDefault(); confirmIfReady(true); } } 
    window.addEventListener("keydown", onKey); 
    return () => window.removeEventListener("keydown", onKey); 
  }, [dupInfo.needed, memberId, order, isLoading, paymentMethod]);

  async function anular(id: string) { try { await voidSaleTx(id, true, "Anulada"); } catch (e: any) { setMsg(e.message || String(e)); } }
  
  async function editar(r: Row) {
    const nuevoTipo = prompt("Tipo (MENU/VEGGIE/CELIACO):", r.itemType)?.toUpperCase(); 
    if (!nuevoTipo || (nuevoTipo !== "MENU" && nuevoTipo !== "VEGGIE" && nuevoTipo !== "CELIACO")) return;
    
    const modo = prompt("Destino (COMEDOR/VIANDA):", r.destination.mode)?.toUpperCase(); 
    if (!modo || (modo !== "COMEDOR" && modo !== "VIANDA")) return;
    
    let mesa: string | null = r.destination.table; 
    if (modo === "COMEDOR") { 
      mesa = prompt("Mesa:", r.destination.table ?? "")?.toUpperCase() || ""; 
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

  const handleGenerarLinkLote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loteDni.trim() || cantidadViandas <= 0 || !montoPagado) return;
    setLoteLoading(true);
    setGeneratedLink("");

    try {
      const functions = getFunctions();
      const generarLink = httpsCallable(functions, 'generarLinkLote');
      
      const result = await generarLink({
        dni: loteDni.trim(),
        cantidadViandas: cantidadViandas,
        montoTotal: Number(montoPagado)
      });

      const data = result.data as any;
      setGeneratedLink(data.init_point);
      
    } catch (error: any) { 
      alert("Error al generar el link. Verificá tu conexión o intentá de nuevo. Detalle: " + error.message); 
    } finally { 
      setLoteLoading(false); 
    }
  };

  return (
    <div style={{ padding: "0 16px" }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 20, borderBottom: "2px solid #e2e8f0", paddingBottom: 8 }}>
        <button onClick={() => setActiveTab("caja_rapida")} style={{ padding: "8px 16px", fontWeight: "bold", borderRadius: "4px 4px 0 0", background: activeTab === "caja_rapida" ? "#3b82f6" : "transparent", color: activeTab === "caja_rapida" ? "#fff" : "#4a5568", border: "none", cursor: "pointer" }}>
          🛒 Caja Rápida Diaria
        </button>
        <button onClick={() => setActiveTab("venta_lotes")} style={{ padding: "8px 16px", fontWeight: "bold", borderRadius: "4px 4px 0 0", background: activeTab === "venta_lotes" ? "#10b981" : "transparent", color: activeTab === "venta_lotes" ? "#fff" : "#4a5568", border: "none", cursor: "pointer" }}>
          📅 Vender Lote Mensual (Mercado Pago)
        </button>
      </div>

      {activeTab === "caja_rapida" ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(400px, 1fr) 2fr", gap: 16 }}>
          <div style={{ display: "grid", gap: 16 }}>
            <div style={{ padding: '8px 12px', borderRadius: '8px', background: isOnline ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)', border: `1px solid ${isOnline ? '#22c55e' : '#ef4444'}`, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: isOnline ? '#22c55e' : '#ef4444', boxShadow: isOnline ? '0 0 8px #22c55e' : '0 0 8px #ef4444' }} />
              <span style={{ fontWeight: 600, color: isOnline ? '#22c55e' : '#ef4444' }}>{isOnline ? "SISTEMA ONLINE" : "SISTEMA OFFLINE"}</span>
            </div>

            {!isOnline && ( <div style={{ background: '#ef4444', color: '#fff', padding: '12px', borderRadius: '8px', fontWeight: 700, textAlign: 'center' }}>⚠️ ATENCIÓN: No hay internet. Las ventas se guardan localmente. <br/> NO CIERRE LA PESTAÑA.</div> )}

            <Card title="1) Escanear carnet">
              <div style={{ display: "grid", gap: 8 }}>
                <input ref={socioRef} className="input" disabled={isLoading} placeholder="Posicioná el cursor aquí y escaneá el QR del socio" value={memberInput} onChange={(e) => { const v = e.target.value; setMemberInput(v); if (hasEnter(v)) { const clean = v.replace(/[\r\n]+/g, " ").trim(); setMemberInput(clean); handleSocioEnter(clean); } }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "NumpadEnter") { e.preventDefault(); handleSocioEnter(memberInput); } }} />
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <span>Socio: <b>{memberId || "-"}</b></span>
                  {isSubsidized && ( <span style={{ background: '#3b82f6', color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 'bold' }}>🎁 SUBVENCIONADO</span> )}
                  {memberBundleRemaining !== null && ( <span style={{ background: '#10b981', color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 'bold' }}>🎟️ LOTE ACTIVO: {memberBundleRemaining} viandas</span> )}
                </div>
                {memberBundleRemaining !== null && memberBundleRemaining <= 3 && ( <div style={{ background: "rgba(239, 68, 68, 0.15)", border: "1px solid #ef4444", color: "#b91c1c", padding: 10, borderRadius: 6, fontWeight: "bold", marginTop: 8 }}>⚠️ ¡ATENCIÓN! Al socio le quedan solo {memberBundleRemaining} viandas en su lote. ¡Avisarle para renovar!</div> )}
              </div>
            </Card>

            <Card title="2) Escanear pedido (comida + destino)">
              <div style={{ display: "grid", gap: 8 }}>
                <input ref={pedidoRef} className="input" disabled={isLoading} placeholder="Luego escaneá el QR de MENU/VEGGIE + MESA/VIANDA" value={orderInput} onChange={(e) => { const v = e.target.value; setOrderInput(v); if (hasEnter(v)) { const clean = v.replace(/[\r\n]+/g, " ").trim(); setOrderInput(clean); handlePedidoEnter(); } }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "NumpadEnter") { e.preventDefault(); handlePedidoEnter(); } }} />
                <div>Pedido: <b>{order ? `${order.itemType} • ${order.dest.mode}${order.dest.table ? " • " + order.dest.table : ""}` : "-"}</b></div>
              </div>
            </Card>

            {!isSubsidized && memberBundleRemaining === null && (
              <Card title="3) Escanear Pago (QR)">
                <div style={{ display: "grid", gap: 8 }}>
                  <input ref={pagoRef} className="input" disabled={isLoading || !order} placeholder="Escaneá PAGO-EFECTIVO o PAGO-MP" value={paymentInput} onChange={(e) => { const v = e.target.value; setPaymentInput(v); if (hasEnter(v)) { const clean = v.replace(/[\r\n]+/g, " ").trim(); setPaymentInput(clean); handlePagoEnter(clean); } }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "NumpadEnter") { e.preventDefault(); handlePagoEnter(paymentInput); } }} />
                  <div>Medio: <b>{paymentMethod || "-"}</b></div>
                </div>
              </Card>
            )}

            <Card title={(isSubsidized || memberBundleRemaining !== null) ? "3) Confirmar" : "4) Confirmar (Opcional si escaneó)"} right={<span style={{ color: "#9aa4c0" }}>Enter en “Pago” confirma.</span>}>
              {dupInfo.needed ? ( <div className="panel" style={{ borderColor: "var(--warn)", background: "rgba(245,158,11,.08)", marginBottom: 10 }}><div style={{ fontWeight: 700, marginBottom: 6 }}>Doble compra detectada</div><div style={{ color: "var(--muted)", marginBottom: 10 }}>{dupInfo.message}</div><div style={{ display: "flex", gap: 8 }}><button className="button" disabled={isLoading} onClick={() => confirmIfReady(true)}>{isLoading ? "Procesando..." : "Permitir y confirmar (F2)"}</button><button className="button outline" disabled={isLoading} onClick={() => { setDupInfo({ needed: false, message: "" }); setTimeout(() => socioRef.current?.focus(), 50); }}>Cancelar</button></div></div> ) : ( <div style={{ color: "var(--muted)" }}>Si hay duplicado se mostrará un aviso.</div> )}
              <div style={{ marginTop: 8, display: "flex", gap: 8 }}><button className="button" disabled={!ready || isLoading} onClick={() => confirmIfReady(false)}>{isLoading ? "Procesando..." : "Guardar Manualmente"}</button><button className="button outline" disabled={isLoading} onClick={() => { setMemberInput(""); setOrderInput(""); setPaymentInput(""); setMemberId(""); setOrder(null); setIsSubsidized(false); setPaymentMethod(null); setMemberBundleRemaining(null); setMsg(""); setDupInfo({ needed: false, message: "" }); socioRef.current?.focus(); }}>Limpiar</button></div>
              <div style={{ marginTop: 8, color: msg ? "var(--danger)" : "inherit", minHeight: 20 }}>{msg}</div>
            </Card>
          </div>

          <div style={{ position: "sticky", top: 64, alignSelf: "start", display: "flex", flexDirection: "column", gap: 8 }}>
            <Card title="Ventas">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, fontWeight: 600, textAlign: "center" }}>
                <div style={{ flex: 1, textAlign: "left" }}>MENU:&nbsp;<span style={{ fontWeight: 400 }}>{totalUsadas.MENU}{limits.MENU != null ? ` / ${limits.MENU} (quedan ${remainingViandas.MENU})` : " / –"}</span></div>
                <div style={{ flex: 1, textAlign: "center" }}>VEGGIE:&nbsp;<span style={{ fontWeight: 400 }}>{totalUsadas.VEGGIE}{limits.VEGGIE != null ? ` / ${limits.VEGGIE} (quedan ${remainingViandas.VEGGIE})` : " / –"}</span></div>
                <div style={{ flex: 1, textAlign: "right" }}>CELIACO:&nbsp;<span style={{ fontWeight: 400 }}>{totalUsadas.CELIACO}{limits.CELIACO != null ? ` / ${limits.CELIACO} (quedan ${remainingViandas.CELIACO})` : " / –"}</span></div>
              </div>
            </Card>

            <Card title={`Resumen hoy ${todayKey()}`}>
              <div style={{ marginBottom: 12, display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
                <input type="text" placeholder="Buscar socio..." value={searchSocio} onChange={(e) => setSearchSocio(e.target.value)} style={{ flex: "1 1 150px", padding: 6, fontSize: 14, boxSizing: "border-box" }} />
                <select value={filterTable} onChange={(e) => setFilterTable(e.target.value)} style={{ padding: 6, fontSize: 14, borderRadius: 4 }}><option value="">Todas las mesas</option>{Array.from({ length: 34 }, (_, i) => { const val = `MESA ${String(i + 1).padStart(2, "0")}`; return <option key={val} value={val}>{val}</option>; })}</select>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", fontWeight: 600 }}><input type="checkbox" checked={filterSubsidized} onChange={(e) => setFilterSubsidized(e.target.checked)} /> Solo Subvencionados 🎁</label>
              </div>
              <p style={{ marginTop: 0, color: "var(--muted)" }}>Listado en vivo. Podés editar rápido o anular.</p>
              <div style={{ maxHeight: "70vh", overflow: "auto" }}>
                <table className="table">
                  <thead><tr><th>Hora</th><th>Socio</th><th>Tipo</th><th>Destino</th><th>Mesa</th><th>Vendedor</th><th></th></tr></thead>
                  <tbody>
                    {filteredRows.map((r) => (
                      <tr key={r.id} style={{ opacity: r.voided ? 0.5 : 1 }}>
                        <td>{r.ts?.toDate ? r.ts.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ""}</td>
                        <td>
                          {r.isSubsidized && subsidizedNames[r.member?.id]?.name ? (
                            <>
                              {subsidizedNames[r.member.id].lastName}, {subsidizedNames[r.member.id].name}
                              <div style={{ fontSize: 11, color: "var(--muted)" }}>{r.member?.id}</div>
                            </>
                          ) : (
                            r.member?.id
                          )}
                          {r.isSubsidized && (<span title="Subvencionado" style={{ marginLeft: 6, fontSize: 12 }}>🎁</span>)}{r.paymentMethod === "LOTE_PREPAGO" && (<span title="Abono Lote" style={{ marginLeft: 6, fontSize: 12 }}>🎟️</span>)}
                        </td>
                        <td>{r.itemType}{r.paymentMethod === "EFECTIVO" && (<span title="Efectivo" style={{ marginLeft: 6, fontSize: 12 }}>💵</span>)}{r.paymentMethod === "MP" && (<span title="Mercado Pago" style={{ marginLeft: 6, fontSize: 12 }}>📱</span>)}</td>
                        <td>{r.destination?.mode}</td>
                        <td>{r.destination?.table ?? "-"}</td>
                        <td>{r.seller?.email?.split('@')[0]}</td>
                        <td style={{ textAlign: "right" }}>{!r.voided ? (<><button className="button ghost" onClick={() => editar(r)} style={{ marginRight: 8 }} disabled={isLoading}>Editar</button><button className="button outline" onClick={() => anular(r.id)} disabled={isLoading}>Anular</button></>) : (<span className="badge">Anulada</span>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
          
          <Card title="Generar Link de Pago para Lote Mensual">
            <form onSubmit={handleGenerarLinkLote} style={{ display: "grid", gap: 16 }}>
              <div>
                <label style={{ display: "block", fontWeight: "bold", marginBottom: 6 }}>DNI del Socio:</label>
                <input type="text" className="input" required placeholder="Ingrese el DNI numérico" value={loteDni} onChange={(e) => setLoteDni(e.target.value)} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={{ display: "block", fontWeight: "bold", marginBottom: 6 }}>Cantidad de Viandas:</label>
                  <select className="input" value={cantidadViandas} onChange={(e) => setCantidadViandas(Number(e.target.value))} style={{ padding: 8 }}>
                    <option value={10}>Lote 10 Viandas</option>
                    <option value={20}>Lote 20 Viandas (Mensual)</option>
                    <option value={30}>Lote 30 Viandas</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: "block", fontWeight: "bold", marginBottom: 6 }}>Total a Cobrar ($):</label>
                  <input type="number" className="input" required placeholder="Ej: 40000" value={montoPagado} onChange={(e) => setMontoPagado(e.target.value)} />
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                    Se calcula solo (${PRECIO_VIANDA_LOTE.toLocaleString("es-AR")} x vianda). Podés editarlo si hace falta un valor distinto.
                  </div>
                </div>
              </div>

              <div style={{ background: "rgba(245, 158, 11, 0.15)", padding: 12, borderRadius: 6, fontSize: 13, color: "#92400e", fontWeight: "bold" }}>
                🔒 SEGURIDAD: Al generar el link, el sistema NO acredita las viandas. Se acreditarán automáticamente cuando el familiar/socio pague con éxito.
              </div>

              <button type="submit" className="button" style={{ background: "#3b82f6", color: "white", padding: "12px", fontWeight: "bold" }} disabled={loteLoading}>
                {loteLoading ? "Conectando con Mercado Pago..." : "Generar Link de Pago 📱"}
              </button>
            </form>

            {generatedLink && (
              <div style={{ marginTop: 20, padding: 16, border: "2px dashed #10b981", borderRadius: 8, background: "#f0fdf4", textAlign: "center" }}>
                <h3 style={{ margin: "0 0 10px 0", color: "#065f46" }}>✅ ¡Link Generado con Éxito!</h3>
                <p style={{ fontSize: 14, color: "#047857", marginBottom: 15 }}>Copiá este enlace y envialo por WhatsApp al familiar para que pague.</p>
                
                <input type="text" readOnly value={generatedLink} style={{ width: "100%", padding: 10, borderRadius: 4, border: "1px solid #a7f3d0", marginBottom: 10, textAlign: "center", fontWeight: "bold" }} />
                
                <button className="button" style={{ background: "#10b981", color: "white", width: "100%" }} onClick={() => { navigator.clipboard.writeText(generatedLink); alert("¡Copiado al portapapeles!"); setLoteDni(""); setMontoPagado(""); setGeneratedLink(""); }}>
                  📋 Copiar Link
                </button>
              </div>
            )}
          </Card>

          <Card title="Últimos Lotes Acreditados Hoy">
            {bundleSales.length === 0 ? (
              <p style={{ color: "var(--muted)", fontStyle: "italic" }}>Aún no hay lotes acreditados hoy.</p>
            ) : (
              <table className="table" style={{ fontSize: 14 }}>
                <thead>
                  <tr>
                    <th>Hora Aprob.</th>
                    <th>DNI Socio</th>
                    <th>Viandas</th>
                    <th>Monto ($)</th>
                  </tr>
                </thead>
                <tbody>
                  {bundleSales.map((b, i) => (
                    <tr key={i} style={{ background: "rgba(16, 185, 129, 0.05)" }}>
                      <td>{b.fecha?.toDate ? b.fecha.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : "-"}</td>
                      <td style={{ fontWeight: "bold" }}>{b.dni}</td>
                      <td>{b.cantidad}</td>
                      <td className="num">${b.monto}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ marginTop: 15, fontSize: 12, color: "var(--muted)" }}>
              * Los pagos realizados por las familias aparecen automáticamente aquí en menos de 30 segundos tras su aprobación en Mercado Pago.
            </div>
          </Card>

        </div>
      )}
    </div>
  );
}
