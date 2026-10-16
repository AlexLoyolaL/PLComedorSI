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
import type { PaymentMethod } from "../lib/sales";
import { Card } from "../ui/Card";
import { doc, onSnapshot, collection, query, orderBy, where, getDoc, serverTimestamp, writeBatch } from "firebase/firestore";
import { db } from "../firebase";
import { getFunctions, httpsCallable } from "firebase/functions";
import { resolveMemberDni } from "../lib/memberId";
import { emptyMemberProfile, isMemberAlertActive, memberProfileFromData, residencyLabel } from "../lib/members";
import type { MemberAlert, MemberProfile } from "../lib/members";

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
  paymentMethod?: PaymentMethod;
};

type OrderData = {
  itemType: "MENU" | "VEGGIE" | "CELIACO";
  dest: { mode: "COMEDOR" | "VIANDA"; table: string | null };
};

type SaleEditForm = {
  itemType: Row["itemType"];
  mode: Row["destination"]["mode"];
  table: string;
  paymentMethod: PaymentMethod;
};

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  EFECTIVO: "Efectivo",
  MP: "Mercado Pago",
  SUBVENCIONADO: "Subvencionado",
  LOTE_PREPAGO: "Lote prepago",
};

function hasEnter(s: string) {
  return /\r|\n/.test(s);
}

export default function Caja() {
  const { user, role } = useAuth();

  const [activeTab, setActiveTab] = useState<"caja_rapida" | "venta_lotes" | "maestro_socios">("caja_rapida");
  const canEditMemberProfiles = role === "root" || role === "administrador" || role === "administrativo";

  const [memberInput, setMemberInput] = useState("");
  const [orderInput, setOrderInput] = useState("");
  const [paymentInput, setPaymentInput] = useState(""); 

  const [limits, setLimits] = useState<{ MENU: number | null; VEGGIE: number | null; CELIACO: number | null; }>({ MENU: null, VEGGIE: null, CELIACO: null });

  const [memberId, setMemberId] = useState("");
  const [order, setOrder] = useState<OrderData | null>(null);
  const [isSubsidized, setIsSubsidized] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<"EFECTIVO" | "MP" | "SUBVENCIONADO" | "LOTE_PREPAGO" | null>(null); 
  
  const [memberBundleRemaining, setMemberBundleRemaining] = useState<number | null>(null); 
  const [memberProfile, setMemberProfile] = useState<MemberProfile | null>(null);
  const [memberAlert, setMemberAlert] = useState<MemberAlert | null>(null);
  const [alertAcknowledged, setAlertAcknowledged] = useState(false);
  const memberLookupRef = useRef(0);

  const [isLoading, setIsLoading] = useState(false);
  const lastScansRef = useRef<Map<string, number>>(new Map());
  const [dupInfo, setDupInfo] = useState<{ needed: boolean; message: string }>({ needed: false, message: "" });
  const [msg, setMsg] = useState("");

  const socioRef = useRef<HTMLInputElement>(null);
  const pedidoRef = useRef<HTMLInputElement>(null);
  const pagoRef = useRef<HTMLInputElement>(null); 

  const ready = useMemo(() => !!memberId && !!order, [memberId, order]);

  const [rows, setRows] = useState<Row[]>([]);
  const [editingSale, setEditingSale] = useState<Row | null>(null);
  const [editForm, setEditForm] = useState<SaleEditForm | null>(null);
  const [editError, setEditError] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [manualAdds, setManualAdds] = useState<any[]>([]);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  const [searchSocio, setSearchSocio] = useState("");
  const [filterTable, setFilterTable] = useState("");
  const [filterSubsidized, setFilterSubsidized] = useState(false);
  const [filterLote, setFilterLote] = useState(false);

  // Lotes (abonos de Mercado Pago) actualmente activos, con viandas
  // disponibles y sin vencer.
  const [activeLotes, setActiveLotes] = useState<{ dni: string; remaining: number; expiresAt: Date | null }[]>([]);

  // Precio por vianda del lote mensual. Actualizalo acá cuando cambie el
  // valor del menú para que el total a cobrar del lote se siga calculando solo.
  const PRECIO_VIANDA_LOTE = 3000;

  const [loteDni, setLoteDni] = useState("");
  const [cantidadViandas, setCantidadViandas] = useState(20);
  const [montoPagado, setMontoPagado] = useState(String(20 * PRECIO_VIANDA_LOTE));
  const [loteLoading, setLoteLoading] = useState(false);
  const [generatedLink, setGeneratedLink] = useState("");
  const [bundleSales, setBundleSales] = useState<any[]>([]);

  // Maestro de socios administrado por Caja
  const [profileSearchInput, setProfileSearchInput] = useState("");
  const [profileDraft, setProfileDraft] = useState<MemberProfile | null>(null);
  const [profileExists, setProfileExists] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState("");

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

  // Lotes activos: socios con abono por Mercado Pago que todavía tienen
  // viandas disponibles y no vencieron.
  useEffect(() => {
    const qLotes = query(collection(db, "members"), where("active_bundle.remaining", ">", 0));
    const unsub = onSnapshot(qLotes, (snap) => {
      const now = new Date();
      const list: { dni: string; remaining: number; expiresAt: Date | null }[] = [];
      snap.forEach((d) => {
        const bundle = (d.data() as any)?.active_bundle;
        if (!bundle) return;
        const expiresAt = bundle.expiresAt?.toDate ? bundle.expiresAt.toDate() : null;
        if (expiresAt && now > expiresAt) return; // vencido: no cuenta como activo
        list.push({ dni: d.id, remaining: bundle.remaining, expiresAt });
      });
      list.sort((a, b) => a.remaining - b.remaining);
      setActiveLotes(list);
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
      setMemberProfile(null);
      setMemberAlert(null);
      setAlertAcknowledged(false);
      setIsSubsidized(false);
      return;
    }

    setAlertAcknowledged(false);

    const unsubSub = onSnapshot(doc(db, "subsidized_members", memberId), (snap) => {
      setIsSubsidized(snap.exists() && snap.data()?.active === true);
    });

    const unsubMember = onSnapshot(doc(db, "members", memberId), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setMemberProfile(memberProfileFromData(memberId, data));
        const bundle = data?.active_bundle;
        const now = new Date(); 
        const expires = bundle?.expiresAt?.toDate ? bundle.expiresAt.toDate() : null;
        if (bundle && bundle.remaining > 0 && (!expires || now < expires)) {
          setMemberBundleRemaining(bundle.remaining);
        } else {
          setMemberBundleRemaining(null);
        }
      } else {
        setMemberBundleRemaining(null);
        setMemberProfile(null);
      }
    });

    const unsubAlert = onSnapshot(
      doc(db, "member_alerts", memberId),
      (snap) => {
        const alert = snap.exists() ? ({ dni: memberId, ...snap.data() } as MemberAlert) : null;
        setMemberAlert(isMemberAlertActive(alert, todayKey()) ? alert : null);
      },
      (error) => {
        console.warn("No se pudo actualizar la alerta del socio:", error);
      }
    );

    return () => { unsubSub(); unsubMember(); unsubAlert(); };
  }, [memberId]);

  const hasPendingAlert = isMemberAlertActive(memberAlert, todayKey()) && !alertAcknowledged;
  const profileDraftStatus = profileDraft
    ? memberProfileFromData(profileDraft.dni, profileDraft).profileStatus
    : null;
  const selectedMemberName = memberProfile?.firstName || memberProfile?.lastName
    ? `${memberProfile.lastName}, ${memberProfile.firstName}`
    : memberId && subsidizedNames[memberId]
      ? `${subsidizedNames[memberId].lastName}, ${subsidizedNames[memberId].name}`
      : "";

  // --- NUEVO: PLC AUTO-DISPARADOR (Evita la condición de carrera del escáner) ---
  useEffect(() => {
    if (order && !paymentMethod && !isLoading && !hasPendingAlert) {
      if (isSubsidized) {
        setPaymentMethod("SUBVENCIONADO");
        confirmIfReady(false, order, "SUBVENCIONADO");
      } else if (memberBundleRemaining !== null && memberBundleRemaining > 0) {
        setPaymentMethod("LOTE_PREPAGO");
        confirmIfReady(false, order, "LOTE_PREPAGO");
      }
    }
  }, [order, memberBundleRemaining, isSubsidized, paymentMethod, isLoading, hasPendingAlert]);

  const filteredRows = useMemo(() => {
    let base = rows.filter((r) => !r.manual);
    if (filterSubsidized) base = base.filter((r) => r.isSubsidized);
    if (filterLote) base = base.filter((r) => r.paymentMethod === "LOTE_PREPAGO");
    if (filterTable) base = base.filter((r) => r.destination?.table === filterTable);
    const q = searchSocio.trim().toLowerCase();
    if (q) base = base.filter((r) => (r.member?.id ?? "").toLowerCase().includes(q));
    return base;
  }, [rows, searchSocio, filterSubsidized, filterLote, filterTable]);

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
    const lookupId = ++memberLookupRef.current;

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

      let activeAlert: MemberAlert | null = null;
      try {
        const alertSnap = await getDoc(doc(db, "member_alerts", finalDni));
        const alert = alertSnap.exists() ? ({ dni: finalDni, ...alertSnap.data() } as MemberAlert) : null;
        activeAlert = isMemberAlertActive(alert, todayKey()) ? alert : null;
      } catch (alertError: any) {
        // Una falla transitoria no debe dejar Caja inutilizable. Se informa al
        // operador que la verificacion no pudo completarse y la venta continua.
        console.warn("No se pudo verificar la alerta del socio:", alertError);
        setMsg("⚠️ No se pudieron verificar las alertas en este momento. Revisá la conexión.");
      }
      if (lookupId !== memberLookupRef.current) return;

      setMemberId(finalDni);
      setMemberAlert(activeAlert);
      setAlertAcknowledged(false);

      if (!activeAlert) {
        setTimeout(() => {
          pedidoRef.current?.focus();
          pedidoRef.current?.select?.();
        }, 50);
      }

    } catch (e: any) {
      setMsg(e.message);
      beep(false);
      setIsSubsidized(false);
      setMemberBundleRemaining(null);
    }
  }

  function handlePedidoEnter() {
    if (hasPendingAlert) {
      setMsg("Confirmá la alerta del socio antes de continuar.");
      return;
    }
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
    if (hasPendingAlert) {
      setMsg("Confirmá la alerta del socio antes de registrar la venta.");
      return;
    }
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
      setMemberProfile(null); setMemberAlert(null); setAlertAcknowledged(false);
      setTimeout(() => socioRef.current?.focus(), 50);
    } catch (e: any) {
      const m = String(e.message || e); 
      if (m.toLowerCase().includes("ya tiene una compra")) setDupInfo({ needed: true, message: m }); 
      else setMsg(m); 
      beep(false);
    } finally { setIsLoading(false); }
  }

  function acknowledgeMemberAlert() {
    setAlertAcknowledged(true);
    setMsg("");
    setTimeout(() => {
      pedidoRef.current?.focus();
      pedidoRef.current?.select?.();
    }, 50);
  }

  async function loadMemberProfile(rawIdentifier: string, switchTab = true) {
    if (!rawIdentifier.trim()) return;
    setProfileMsg("");
    try {
      const dni = await resolveMemberDni(rawIdentifier);
      if (!dni) throw new Error("No se pudo resolver un DNI válido.");
      const snap = await getDoc(doc(db, "members", dni));
      setProfileExists(snap.exists());
      let draft = snap.exists() ? memberProfileFromData(dni, snap.data()) : emptyMemberProfile(dni);
      if (!draft.firstName || !draft.lastName) {
        const subsidizedSnap = await getDoc(doc(db, "subsidized_members", dni));
        const subsidized = subsidizedSnap.data();
        if (subsidizedSnap.exists()) {
          draft = memberProfileFromData(dni, {
            ...draft,
            firstName: draft.firstName || subsidized?.name,
            lastName: draft.lastName || subsidized?.lastName,
          });
        }
      }
      setProfileDraft(draft);
      setProfileSearchInput("");
      setProfileMsg(snap.exists() ? "Ficha cargada." : "El socio todavía no tiene ficha. Completá sus datos para crearla.");
      if (switchTab) setActiveTab("maestro_socios");
    } catch (e: any) {
      setProfileMsg(e?.message || String(e));
    }
  }

  async function saveMemberProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !profileDraft || !canEditMemberProfiles) return;

    const normalized = memberProfileFromData(profileDraft.dni, profileDraft);
    if (!normalized.firstName.trim() || !normalized.lastName.trim()) {
      setProfileMsg("Nombre y apellido son obligatorios.");
      return;
    }

    setProfileSaving(true);
    setProfileMsg("");
    try {
      const memberRef = doc(db, "members", normalized.dni);
      const subsidizedRef = doc(db, "subsidized_members", normalized.dni);
      const [current, subsidized] = await Promise.all([
        getDoc(memberRef),
        getDoc(subsidizedRef),
      ]);
      const actor = { uid: user.uid, email: user.email ?? "", name: user.displayName ?? "" };
      const payload: any = {
        id: normalized.dni,
        dni: normalized.dni,
        firstName: normalized.firstName.trim().toUpperCase(),
        name: normalized.firstName.trim().toUpperCase(),
        lastName: normalized.lastName.trim().toUpperCase(),
        birthDate: normalized.birthDate,
        address: {
          street: normalized.address.street.trim().toUpperCase(),
          number: normalized.address.number.trim().toUpperCase(),
          locality: normalized.address.locality.trim().toUpperCase(),
        },
        residencyStatus: normalized.residencyStatus,
        profileStatus: normalized.profileStatus,
        updatedAt: serverTimestamp(),
        updatedBy: actor,
      };
      if (!current.exists()) {
        payload.createdAt = serverTimestamp();
        payload.createdBy = actor;
        payload.active = true;
      }
      const batch = writeBatch(db);
      batch.set(memberRef, payload, { merge: true });
      if (subsidized.exists()) {
        // Si además es subvencionado, mantenemos compatible el padrón legado
        // para que ambas pantallas muestren siempre el mismo nombre.
        batch.set(subsidizedRef, {
          name: payload.firstName,
          lastName: payload.lastName,
        }, { merge: true });
      }
      await batch.commit();
      const savedProfile = memberProfileFromData(normalized.dni, payload);
      setProfileDraft(savedProfile);
      setProfileExists(true);
      if (memberId === normalized.dni) setMemberProfile(savedProfile);
      setProfileMsg(`✅ Ficha guardada como ${savedProfile.profileStatus.toLowerCase()}.`);
    } catch (e: any) {
      setProfileMsg("Error al guardar la ficha: " + (e?.message || String(e)));
    } finally {
      setProfileSaving(false);
    }
  }

  useEffect(() => { 
    function onKey(e: KeyboardEvent) { if (dupInfo.needed && e.key === "F2") { e.preventDefault(); confirmIfReady(true); } } 
    window.addEventListener("keydown", onKey); 
    return () => window.removeEventListener("keydown", onKey); 
  }, [dupInfo.needed, memberId, order, isLoading, paymentMethod]);

  async function anular(id: string) { try { await voidSaleTx(id, true, "Anulada"); } catch (e: any) { setMsg(e.message || String(e)); } }
  
  function editar(r: Row) {
    setEditingSale(r);
    setEditForm({
      itemType: r.itemType,
      mode: r.destination.mode,
      table: r.destination.table ?? "MESA 01",
      paymentMethod: r.isSubsidized ? "SUBVENCIONADO" : (r.paymentMethod ?? "EFECTIVO"),
    });
    setEditError("");
  }

  function cerrarEdicion() {
    if (isSavingEdit) return;
    setEditingSale(null);
    setEditForm(null);
    setEditError("");
  }

  async function guardarEdicion(e: React.FormEvent) {
    e.preventDefault();
    if (!editingSale || !editForm) return;
    if (editForm.mode === "COMEDOR" && !editForm.table) {
      setEditError("Seleccioná una mesa.");
      return;
    }

    setIsSavingEdit(true);
    setEditError("");
    try {
      await updateSaleTx({
        saleId: editingSale.id,
        newItemType: editForm.itemType,
        newDest: {
          mode: editForm.mode,
          table: editForm.mode === "COMEDOR" ? editForm.table : null,
        },
        newPaymentMethod: editForm.paymentMethod,
      });
      setEditingSale(null);
      setEditForm(null);
      setEditError("");
    } catch (e: any) {
      setEditError(e.message || String(e));
    } finally {
      setIsSavingEdit(false);
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
        {canEditMemberProfiles && (
          <button onClick={() => setActiveTab("maestro_socios")} style={{ padding: "8px 16px", fontWeight: "bold", borderRadius: "4px 4px 0 0", background: activeTab === "maestro_socios" ? "#8b5cf6" : "transparent", color: activeTab === "maestro_socios" ? "#fff" : "#4a5568", border: "none", cursor: "pointer" }}>
            👤 Maestro de Socios
          </button>
        )}
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
                  {memberId && selectedMemberName && (
                    <span style={{ fontWeight: 700 }}>{selectedMemberName}</span>
                  )}
                  {memberId && (
                    <span className="badge" style={{ borderColor: memberProfile?.profileStatus === "COMPLETO" ? "#22c55e" : "#f59e0b" }}>
                      {memberProfile?.profileStatus === "COMPLETO" ? residencyLabel(memberProfile.residencyStatus) : "Ficha incompleta"}
                    </span>
                  )}
                  {isSubsidized && ( <span style={{ background: '#3b82f6', color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 'bold' }}>🎁 SUBVENCIONADO</span> )}
                  {memberBundleRemaining !== null && ( <span style={{ background: '#10b981', color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 'bold' }}>🎟️ LOTE ACTIVO: {memberBundleRemaining} viandas</span> )}
                  {memberId && canEditMemberProfiles && (
                    <button className="button ghost" style={{ padding: "5px 10px" }} onClick={() => loadMemberProfile(memberId)}>
                      {memberProfile ? "Editar ficha" : "Completar ficha"}
                    </button>
                  )}
                </div>
                {memberBundleRemaining !== null && memberBundleRemaining <= 3 && ( <div style={{ background: "rgba(239, 68, 68, 0.15)", border: "1px solid #ef4444", color: "#b91c1c", padding: 10, borderRadius: 6, fontWeight: "bold", marginTop: 8 }}>⚠️ ¡ATENCIÓN! Al socio le quedan solo {memberBundleRemaining} viandas en su lote. ¡Avisarle para renovar!</div> )}
              </div>
            </Card>

            <Card title="2) Escanear pedido (comida + destino)">
              <div style={{ display: "grid", gap: 8 }}>
                  <input ref={pedidoRef} className="input" disabled={isLoading || hasPendingAlert} placeholder={hasPendingAlert ? "Confirmá la alerta antes de continuar" : "Luego escaneá el QR de MENU/VEGGIE + MESA/VIANDA"} value={orderInput} onChange={(e) => { const v = e.target.value; setOrderInput(v); if (hasEnter(v)) { const clean = v.replace(/[\r\n]+/g, " ").trim(); setOrderInput(clean); handlePedidoEnter(); } }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "NumpadEnter") { e.preventDefault(); handlePedidoEnter(); } }} />
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
              <div style={{ marginTop: 8, display: "flex", gap: 8 }}><button className="button" disabled={!ready || isLoading || hasPendingAlert} onClick={() => confirmIfReady(false)}>{isLoading ? "Procesando..." : "Guardar Manualmente"}</button><button className="button outline" disabled={isLoading} onClick={() => { memberLookupRef.current += 1; setMemberInput(""); setOrderInput(""); setPaymentInput(""); setMemberId(""); setOrder(null); setIsSubsidized(false); setPaymentMethod(null); setMemberBundleRemaining(null); setMemberProfile(null); setMemberAlert(null); setAlertAcknowledged(false); setMsg(""); setDupInfo({ needed: false, message: "" }); socioRef.current?.focus(); }}>Limpiar</button></div>
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
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", fontWeight: 600 }}><input type="checkbox" checked={filterLote} onChange={(e) => setFilterLote(e.target.checked)} /> Solo Lotes 🎟️</label>
              </div>
              <p style={{ marginTop: 0, color: "var(--muted)" }}>Listado en vivo. Podés editar rápido o anular.</p>
              <div style={{ maxHeight: "70vh", overflow: "auto" }}>
                <table className="table">
                  <thead><tr><th>Hora</th><th>Socio</th><th>Tipo</th><th>Pago</th><th>Destino</th><th>Mesa</th><th>Vendedor</th><th></th></tr></thead>
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
                        <td>{r.itemType}</td>
                        <td>{PAYMENT_LABELS[r.isSubsidized ? "SUBVENCIONADO" : (r.paymentMethod ?? "EFECTIVO")]}</td>
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
      ) : activeTab === "venta_lotes" ? (
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

          <div style={{ gridColumn: "1 / -1" }}>
            <Card title={`Lotes Activos (${activeLotes.length})`}>
              {activeLotes.length === 0 ? (
                <p style={{ color: "var(--muted)", fontStyle: "italic" }}>No hay lotes activos con viandas disponibles.</p>
              ) : (
                <table className="table" style={{ fontSize: 14 }}>
                  <thead>
                    <tr>
                      <th>DNI Socio</th>
                      <th>Viandas Restantes</th>
                      <th>Vence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeLotes.map((l) => (
                      <tr key={l.dni} style={{ background: l.remaining <= 3 ? "rgba(239, 68, 68, 0.08)" : undefined }}>
                        <td style={{ fontWeight: "bold" }}>
                          {subsidizedNames[l.dni]?.name ? `${subsidizedNames[l.dni].lastName}, ${subsidizedNames[l.dni].name} (${l.dni})` : l.dni}
                        </td>
                        <td>
                          {l.remaining}
                          {l.remaining <= 3 && (<span title="Por agotarse" style={{ marginLeft: 6, fontSize: 12 }}>⚠️</span>)}
                        </td>
                        <td>{l.expiresAt ? l.expiresAt.toLocaleDateString("es-AR") : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div style={{ marginTop: 15, fontSize: 12, color: "var(--muted)" }}>
                * Lista en vivo. Solo se muestran socios con viandas disponibles y lote sin vencer.
              </div>
            </Card>
          </div>

        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, .8fr) 2fr", gap: 16, alignItems: "start" }}>
          <Card title="Buscar socio">
            <div style={{ display: "grid", gap: 12 }}>
              <p style={{ margin: 0, color: "var(--muted)" }}>
                Escaneá un carnet o ingresá el DNI para crear o actualizar su ficha maestra.
              </p>
              <input
                className="input"
                placeholder="DNI sin puntos o código del carnet"
                value={profileSearchInput}
                onChange={(e) => setProfileSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && loadMemberProfile(profileSearchInput, false)}
              />
              <button className="button" onClick={() => loadMemberProfile(profileSearchInput, false)}>Buscar</button>
              {memberId && (
                <button className="button outline" onClick={() => loadMemberProfile(memberId, false)}>
                  Cargar socio actual: {memberId}
                </button>
              )}
              {profileMsg && (
                <div style={{ color: profileMsg.startsWith("✅") ? "var(--ok)" : "var(--muted)", fontSize: 13 }}>
                  {profileMsg}
                </div>
              )}
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                Caja administra estos datos. La información del lote se conserva y no se modifica desde este formulario.
              </div>
            </div>
          </Card>

          <Card title={profileDraft ? `Ficha de socio · DNI ${profileDraft.dni}` : "Maestro de Socios"}>
            {!profileDraft ? (
              <div style={{ color: "var(--muted)", padding: 20, textAlign: "center" }}>
                Buscá un DNI para abrir su ficha.
              </div>
            ) : (
              <form onSubmit={saveMemberProfile} style={{ display: "grid", gap: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="badge" style={{ borderColor: profileExists ? "#22c55e" : "#f59e0b" }}>
                    {profileExists ? "Ficha existente" : "Nueva ficha"}
                  </span>
                  <span className="badge" style={{ borderColor: profileDraftStatus === "COMPLETO" ? "#22c55e" : "#f59e0b" }}>
                    {profileDraftStatus === "COMPLETO" ? "Completa" : "Incompleta"}
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontWeight: 700 }}>Nombre *</span>
                    <input className="input" value={profileDraft.firstName} onChange={(e) => setProfileDraft({ ...profileDraft, firstName: e.target.value })} />
                  </label>
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontWeight: 700 }}>Apellido *</span>
                    <input className="input" value={profileDraft.lastName} onChange={(e) => setProfileDraft({ ...profileDraft, lastName: e.target.value })} />
                  </label>
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontWeight: 700 }}>Fecha de nacimiento</span>
                    <input className="input" type="date" max={todayKey()} value={profileDraft.birthDate} onChange={(e) => setProfileDraft({ ...profileDraft, birthDate: e.target.value })} />
                  </label>
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontWeight: 700 }}>Domicilio en San Isidro</span>
                    <select className="input" value={profileDraft.residencyStatus} onChange={(e) => setProfileDraft({ ...profileDraft, residencyStatus: e.target.value as MemberProfile["residencyStatus"] })}>
                      <option value="SIN_VERIFICAR">Sin verificar</option>
                      <option value="SAN_ISIDRO">Sí</option>
                      <option value="FUERA_SAN_ISIDRO">No</option>
                    </select>
                  </label>
                </div>

                <div>
                  <div style={{ fontWeight: 800, marginBottom: 8 }}>Domicilio</div>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr .7fr 1.3fr", gap: 12 }}>
                    <label style={{ display: "grid", gap: 6 }}>
                      <span>Calle</span>
                      <input className="input" value={profileDraft.address.street} onChange={(e) => setProfileDraft({ ...profileDraft, address: { ...profileDraft.address, street: e.target.value } })} />
                    </label>
                    <label style={{ display: "grid", gap: 6 }}>
                      <span>Número</span>
                      <input className="input" value={profileDraft.address.number} onChange={(e) => setProfileDraft({ ...profileDraft, address: { ...profileDraft.address, number: e.target.value } })} />
                    </label>
                    <label style={{ display: "grid", gap: 6 }}>
                      <span>Localidad</span>
                      <input className="input" value={profileDraft.address.locality} onChange={(e) => setProfileDraft({ ...profileDraft, address: { ...profileDraft.address, locality: e.target.value } })} />
                    </label>
                  </div>
                </div>

                <div style={{ padding: 10, borderRadius: 10, background: profileDraft.residencyStatus === "FUERA_SAN_ISIDRO" ? "rgba(245,158,11,.12)" : "rgba(79,140,255,.10)" }}>
                  {profileDraft.residencyStatus === "FUERA_SAN_ISIDRO"
                    ? "Domicilio fuera de San Isidro. Este dato quedará preparado para la futura regla de recargo."
                    : residencyLabel(profileDraft.residencyStatus)}
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button className="button" type="submit" disabled={profileSaving}>
                    {profileSaving ? "Guardando..." : "Guardar ficha"}
                  </button>
                </div>
              </form>
            )}
          </Card>
        </div>
      )}

      {hasPendingAlert && memberAlert && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="member-alert-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 130,
            display: "grid",
            placeItems: "center",
            padding: 20,
            background: "rgba(3, 8, 20, 0.82)",
          }}
        >
          <div className="panel" style={{ width: "min(620px, 100%)", border: `2px solid ${memberAlert.level === "IMPORTANTE" ? "#f59e0b" : "#3b82f6"}`, boxShadow: "0 24px 90px rgba(0,0,0,.55)" }}>
            <div style={{ fontSize: 42, textAlign: "center" }}>{memberAlert.level === "IMPORTANTE" ? "⚠️" : "ℹ️"}</div>
            <h2 id="member-alert-title" style={{ textAlign: "center", margin: "4px 0 12px" }}>
              Alerta de Gabinete Social
            </h2>
            <div style={{ textAlign: "center", color: "var(--muted)", marginBottom: 16 }}>
              {memberProfile?.firstName || memberProfile?.lastName
                ? `${memberProfile.lastName}, ${memberProfile.firstName} · `
                : ""}
              DNI {memberId}
            </div>
            <div style={{ padding: 18, borderRadius: 12, background: memberAlert.level === "IMPORTANTE" ? "rgba(245,158,11,.14)" : "rgba(59,130,246,.14)", fontSize: 18, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {memberAlert.message}
            </div>
            {memberAlert.validUntil && (
              <div style={{ textAlign: "center", color: "var(--muted)", fontSize: 12, marginTop: 10 }}>
                Vigente hasta {memberAlert.validUntil}
              </div>
            )}
            <button className="button" style={{ width: "100%", marginTop: 18, padding: 14, fontSize: 16 }} onClick={acknowledgeMemberAlert} autoFocus>
              Entendido, continuar
            </button>
          </div>
        </div>
      )}

      {editingSale && editForm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="editar-venta-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            display: "grid",
            placeItems: "center",
            padding: 20,
            background: "rgba(3, 8, 20, 0.78)",
          }}
        >
          <form
            onSubmit={guardarEdicion}
            className="panel"
            style={{ width: "min(560px, 100%)", display: "grid", gap: 16, boxShadow: "0 24px 80px rgba(0,0,0,.5)" }}
          >
            <div>
              <h2 id="editar-venta-title" style={{ margin: 0 }}>Editar venta</h2>
              <div style={{ color: "var(--muted)", marginTop: 4 }}>
                Socio {editingSale.member?.id} · Revisá los datos antes de guardar.
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontWeight: 700 }}>Tipo de comida</span>
                <select className="input" value={editForm.itemType} onChange={(e) => setEditForm({ ...editForm, itemType: e.target.value as Row["itemType"] })}>
                  <option value="MENU">Menú</option>
                  <option value="VEGGIE">Veggie</option>
                  <option value="CELIACO">Celíaco</option>
                </select>
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontWeight: 700 }}>Medio de pago</span>
                <select className="input" value={editForm.paymentMethod} onChange={(e) => setEditForm({ ...editForm, paymentMethod: e.target.value as PaymentMethod })}>
                  <option value="EFECTIVO">Efectivo</option>
                  <option value="MP">Mercado Pago</option>
                  <option value="SUBVENCIONADO">Subvencionado</option>
                  <option value="LOTE_PREPAGO">Lote prepago</option>
                </select>
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontWeight: 700 }}>Destino</span>
                <select className="input" value={editForm.mode} onChange={(e) => setEditForm({ ...editForm, mode: e.target.value as Row["destination"]["mode"] })}>
                  <option value="COMEDOR">Comedor</option>
                  <option value="VIANDA">Vianda</option>
                </select>
              </label>

              <label style={{ display: "grid", gap: 6, opacity: editForm.mode === "COMEDOR" ? 1 : 0.55 }}>
                <span style={{ fontWeight: 700 }}>Mesa</span>
                <select
                  className="input"
                  value={editForm.table}
                  disabled={editForm.mode !== "COMEDOR"}
                  onChange={(e) => setEditForm({ ...editForm, table: e.target.value })}
                >
                  {Array.from({ length: 34 }, (_, i) => {
                    const table = `MESA ${String(i + 1).padStart(2, "0")}`;
                    return <option key={table} value={table}>{table}</option>;
                  })}
                </select>
              </label>
            </div>

            <div style={{ padding: 10, borderRadius: 10, background: "rgba(79,140,255,.10)", color: "var(--muted)", fontSize: 13 }}>
              Si cambiás a lote o subvencionado, el sistema valida que el socio tenga ese beneficio activo y ajusta los contadores automáticamente.
            </div>

            {editError && (
              <div style={{ color: "var(--danger)", padding: 10, border: "1px solid var(--danger)", borderRadius: 10 }}>
                {editError}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="button outline" onClick={cerrarEdicion} disabled={isSavingEdit}>Cancelar</button>
              <button type="submit" className="button" disabled={isSavingEdit}>
                {isSavingEdit ? "Guardando..." : "Guardar cambios"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
