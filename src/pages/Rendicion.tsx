import React, { useEffect, useMemo, useState } from "react";
import { listenTodaySales, todayKey } from "../lib/sales";
import { doc, setDoc, serverTimestamp, collection, query, where, onSnapshot } from "firebase/firestore";
import { db, storage } from "../firebase";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

type Row = any;

export type RendicionState = {
  valorMenu: number;
  valorVeggie: number;
  valorCeliaco: number;
  valorAcompMenu: number;
  valorAcompVeggie: number;
  valorMp: number;
  manual: {
    acompMenuComensales: number;
    acompVeggieComensales: number;
    subvencionados: number; // Esto es el "Extra sin cargo" manual
  };
  observaciones: string;
};

type BlockProps = {
  blockId?: string;
  fechaTexto: string;
  diaSemana: string;
  totalMenuEfectivo: number;
  totalVeggieEfectivo: number;
  totalCeliacoEfectivo: number;
  totalComensales: number;
  totalMpCaja: number; 
  totalLotesConsumidos: number; // Platos consumidos hoy con Abono
  bundleSales: any[];           // Abonos/Lotes vendidos hoy
  responsablesVenta: string[];
  state: RendicionState;
  updateState: (newState: Partial<RendicionState>) => void;
  updateManual: (field: keyof RendicionState["manual"], value: number) => void;
};

const RendicionBlock: React.FC<BlockProps> = ({
  blockId,
  fechaTexto,
  diaSemana,
  totalMenuEfectivo,
  totalVeggieEfectivo,
  totalCeliacoEfectivo,
  totalComensales,
  totalMpCaja,
  totalLotesConsumidos,
  bundleSales,
  responsablesVenta,
  state,
  updateState,
  updateManual
}) => {
  const menuCalculado = Math.max(0, totalMenuEfectivo - state.manual.acompMenuComensales - state.manual.subvencionados);
  const veggieCalculado = Math.max(0, totalVeggieEfectivo - state.manual.acompVeggieComensales);
  const celiacoCalculado = totalCeliacoEfectivo;

  const recMenu = state.valorMenu * menuCalculado;
  const recVeggie = state.valorVeggie * veggieCalculado;
  const recCeliaco = state.valorCeliaco * celiacoCalculado;
  
  const recAcompMenu = state.valorAcompMenu * state.manual.acompMenuComensales;
  const recAcompVeggie = state.valorAcompVeggie * state.manual.acompVeggieComensales;
  const recMp = state.valorMp * totalMpCaja;

  // CÁLCULO DE INGRESOS POR LOTES (Se asume que el 100% entra por Mercado Pago a través del Webhook)
  const totalLotesMp = bundleSales.reduce((sum, b) => sum + (Number(b.monto) || 0), 0);

  // El efectivo de la caja física se compone estrictamente de la venta tradicional del mostrador
  const totalEfectivo = recMenu + recVeggie + recCeliaco + recAcompMenu + recAcompVeggie;
  const totalMpFinal = recMp + totalLotesMp;

  const formatCurrency = (n: number) => n === 0 ? "" : `$ ${n.toLocaleString("es-AR")}`;

  return (
    <div className="rendicion-card" id={blockId}>
      <div className="rendicion-header">
        <div className="rendicion-title">COMEDOR PUERTO LIBRE - LIQUIDACION</div>
        <div className="rendicion-subtitle">COOPERADORA JUVENTUD PROLONGADA</div>
        <div className="rendicion-date">
          DIA {diaSemana.toUpperCase()} FECHA: {fechaTexto}
        </div>
      </div>

      <table className="rendicion-table">
        <thead>
          <tr>
            <th>CONCEPTO</th>
            <th>VALOR BONO</th>
            <th>CANTIDAD</th>
            <th>RECAUDACIÓN</th>
          </tr>
        </thead>

        <tbody>
          <tr>
            <td>MENU DEL DÍA</td>
            <td><input className="editable-input" type="number" value={state.valorMenu} onChange={(e) => updateState({ valorMenu: Number(e.target.value) })} /></td>
            <td><input type="number" value={menuCalculado} readOnly /></td>
            <td className="num">{formatCurrency(recMenu)}</td>
          </tr>

          <tr>
            <td>VEGGIE</td>
            <td><input className="editable-input" type="number" value={state.valorVeggie} onChange={(e) => updateState({ valorVeggie: Number(e.target.value) })} /></td>
            <td><input type="number" value={veggieCalculado} readOnly /></td>
            <td className="num">{formatCurrency(recVeggie)}</td>
          </tr>

          <tr>
            <td>CELIACO</td>
            <td><input className="editable-input" type="number" value={state.valorCeliaco} onChange={(e) => updateState({ valorCeliaco: Number(e.target.value) })} /></td>
            <td><input type="number" value={celiacoCalculado} readOnly /></td>
            <td className="num">{formatCurrency(recCeliaco)}</td>
          </tr>

          <tr>
            <td>PAGOS MERCADO PAGO</td>
            <td><input className="editable-input" type="number" value={state.valorMp} onChange={(e) => updateState({ valorMp: Number(e.target.value) })} /></td>
            <td><input type="number" value={totalMpCaja} readOnly style={{ background: "#f3f4f6" }} /></td>
            <td className="num">{formatCurrency(recMp)}</td>
          </tr>

          <tr>
            <td style={{ color: "#3b82f6", fontWeight: "bold" }}>Extra sin cargo</td>
            <td>$ 0</td>
            <td><input className="editable-input" type="number" value={state.manual.subvencionados} onChange={(e) => updateManual("subvencionados", Number(e.target.value))} /></td>
            <td className="num">$ 0</td>
          </tr>

          {/* Consumos realizados utilizando Lotes Prepagos */}
          <tr>
            <td style={{ color: "#10b981", fontWeight: "bold" }}>Consumos por Lote (Abono)</td>
            <td>$ 0</td>
            <td><input type="number" value={totalLotesConsumidos} readOnly style={{ background: "#f3f4f6" }} /></td>
            <td className="num">$ 0</td>
          </tr>
        </tbody>
      </table>

      {/* BLOQUE REFACTORIZADO: EXCLUSIVO PARA RECAUDACIÓN DE LOTES POR MERCADO PAGO */}
      <div className="rendicion-subtitle" style={{ marginTop: 15, fontSize: 13, background: "#f1f5f9", padding: 4 }}>
        INGRESOS POR VENTA DE ABONOS (LOTES)
      </div>
      <table className="rendicion-table" style={{ marginTop: 0 }}>
        <thead>
          <tr>
            <th>CONCEPTO</th>
            <th>CANT. LOTES</th>
            <th>RECAUDACIÓN MERCADO PAGO</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ fontWeight: "bold" }}>Nuevos Lotes Digitales</td>
            <td>{bundleSales.length} Lote(s)</td>
            <td className="num" style={{ fontWeight: "bold", color: "#10b981" }}>{formatCurrency(totalLotesMp)}</td>
          </tr>
        </tbody>
      </table>

      <div className="rendicion-totales" style={{ marginTop: 15 }}>
        <div>TOTAL DE COMENSALES: {totalComensales}</div>
        <div>TOTAL CAJA EFECTIVO: {formatCurrency(totalEfectivo)}</div>
        <div>TOTAL MERCADO PAGO · VENTA DIARIA: {formatCurrency(recMp)}</div>
        <div>TOTAL MERCADO PAGO · VENTA POR LOTE: {formatCurrency(totalLotesMp)}</div>
        <div>TOTAL MERCADO PAGO GENERAL: {formatCurrency(totalMpFinal)}</div>
      </div>

      <div className="rendicion-observaciones">
        <div>OBSERVACIONES:</div>
        <textarea
          className="obs-textarea editable-area"
          value={state.observaciones}
          onChange={(e) => updateState({ observaciones: e.target.value })}
        />
      </div>

      <div className="rendicion-firma" style={{ marginTop: 30 }}>
        <div style={{ marginBottom: 8 }}>
          RESPONSABLE DE VENTA: <strong>{responsablesVenta.length > 0 ? responsablesVenta.join(" · ") : "Sin ventas registradas"}</strong>
        </div>
        <div className="firma-line" style={{ borderBottom: '1px solid #000', width: '250px', marginBottom: 4 }} />
        <span style={{ fontSize: 10, color: '#666' }}>FIRMA Y ACLARACIÓN</span>
      </div>
    </div>
  );
};

const RendicionPage: React.FC = () => {
  const [rows, setRows] = useState<Row[]>([]);
  const [bundleSales, setBundleSales] = useState<any[]>([]); 
  const [isSaving, setIsSaving] = useState(false);
  const [hasSaved, setHasSaved] = useState(false); 
  
  const [sharedState, setSharedState] = useState<RendicionState>({
    valorMenu: 3000,
    valorVeggie: 3000,
    valorCeliaco: 3000,
    valorAcompMenu: 3000,
    valorAcompVeggie: 3000,
    valorMp: 3000,
    manual: {
      acompMenuComensales: 0,
      acompVeggieComensales: 0,
      subvencionados: 0,
    },
    observaciones: "",
  });

  const updateSharedState = (newState: Partial<RendicionState>) => {
    setSharedState(prev => ({ ...prev, ...newState }));
    setHasSaved(false); 
  };

  const updateManualState = (field: keyof RendicionState["manual"], value: number) => {
    const safeValue = isNaN(value) ? 0 : value;
    setSharedState(prev => ({
      ...prev,
      manual: { ...prev.manual, [field]: safeValue }
    }));
    setHasSaved(false);
  };

  useEffect(() => listenTodaySales(setRows), []);

  useEffect(() => {
    const qBundle = query(collection(db, "bundle_sales"), where("dateKey", "==", todayKey()));
    const unsub = onSnapshot(qBundle, snap => {
      setBundleSales(snap.docs.map(d => d.data()));
    });
    return () => unsub();
  }, []);

  const autoCounts = useMemo(() => {
    let menuCash = 0, veggieCash = 0, celiacoCash = 0;
    let mpTotal = 0;
    let totalComensales = 0;

    rows.forEach((r: any) => {
      const memberId = (r.member?.id ?? "").trim();
      if (r.voided || r.manual || memberId === "") return;

      totalComensales++;
      if (r.isSubsidized || r.paymentMethod === "SUBVENCIONADO" || r.paymentMethod === "LOTE_PREPAGO") return;

      if (r.paymentMethod === "MP") {
        mpTotal++;
        return;
      }

      if (r.itemType === "MENU") menuCash++;
      if (r.itemType === "VEGGIE") veggieCash++;
      if (r.itemType === "CELIACO") celiacoCash++;
    });

    return { menuCash, veggieCash, celiacoCash, mpTotal, totalComensales };
  }, [rows]);

  const totalLotesConsumidos = useMemo(() => rows.filter(r => !r.voided && r.paymentMethod === "LOTE_PREPAGO").length, [rows]);

  const responsablesVenta = useMemo(() => {
    const sellers = new Map<string, string>();
    rows.forEach((r: any) => {
      if (r.voided || r.manual) return;
      const key = r.seller?.uid || r.seller?.email;
      if (!key) return;
      const label = r.seller?.name?.trim() || r.seller?.email || "Usuario sin nombre";
      sellers.set(key, label);
    });
    return Array.from(sellers.values()).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const now = new Date();
  const fechaTexto = now.toLocaleDateString("es-AR");
  const dias = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  const diaSemana = dias[now.getDay()];

  const handleSaveDB = async () => {
    setIsSaving(true);
    try {
      const element = document.getElementById("rendicion-original");
      if (!element) throw new Error("No se encontró la tabla para imprimir");
      
      const menuCalculado = Math.max(0, autoCounts.menuCash - sharedState.manual.acompMenuComensales - sharedState.manual.subvencionados);
      const veggieCalculado = Math.max(0, autoCounts.veggieCash - sharedState.manual.acompVeggieComensales);
      const celiacoCalculado = autoCounts.celiacoCash;

      const recMenu = sharedState.valorMenu * menuCalculado;
      const recVeggie = sharedState.valorVeggie * veggieCalculado;
      const recCeliaco = sharedState.valorCeliaco * celiacoCalculado;
      const recAcompMenu = sharedState.valorAcompMenu * sharedState.manual.acompMenuComensales;
      const recAcompVeggie = sharedState.valorAcompVeggie * sharedState.manual.acompVeggieComensales;
      const recMp = sharedState.valorMp * autoCounts.mpTotal;

      const totalLotesMp = bundleSales.reduce((sum, b) => sum + (Number(b.monto) || 0), 0);

      const totalComensales = autoCounts.totalComensales;
      const totalEfectivo = recMenu + recVeggie + recCeliaco + recAcompMenu + recAcompVeggie;
      const totalMpFinal = recMp + totalLotesMp;
      
      const qtyEfectivo = menuCalculado + veggieCalculado + celiacoCalculado + sharedState.manual.acompMenuComensales + sharedState.manual.acompVeggieComensales;

      const canvas = await html2canvas(element, { scale: 2 });
      const imgData = canvas.toDataURL("image/png");
      
      const pdf = new jsPDF("p", "mm", "a4");
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      
      pdf.addImage(imgData, "PNG", 0, 10, pdfWidth, pdfHeight);
      const pdfBlob = pdf.output("blob");

      const uniqueName = `rendicion_${todayKey()}_${Date.now()}.pdf`;
      const storageRef = ref(storage, `rendiciones/${uniqueName}`);
      await uploadBytes(storageRef, pdfBlob);
      const pdfUrl = await getDownloadURL(storageRef);

      await setDoc(doc(db, "dayAgg", todayKey()), {
        payments: { cash: qtyEfectivo, mp: autoCounts.mpTotal, extraSinCargoManual: sharedState.manual.subvencionados },
        lastUpdated: serverTimestamp()
      }, { merge: true });

      await setDoc(doc(db, "rendiciones_audit", todayKey()), {
        dateKey: todayKey(),
        timestamp: serverTimestamp(),
        pdfUrl: pdfUrl,
        observaciones: sharedState.observaciones,
        responsablesVenta,
        realizadoPor: responsablesVenta.join(" · "),
        totales: {
          comensalesTotales: totalComensales,
          efectivoPesos: totalEfectivo,
          mpPesos: totalMpFinal,
          mpVentaDiariaPesos: recMp,
          mpVentaLotesPesos: totalLotesMp,
          qtyEfectivo: qtyEfectivo,
          qtyMp: autoCounts.mpTotal,
          qtyExtraSinCargo: sharedState.manual.subvencionados,
          lotesConsumidos: totalLotesConsumidos,
          lotesVendidosHoy: bundleSales.length
        }
      });

      setHasSaved(true); 
      alert("✅ ¡Rendición guardada exitosamente y PDF generado para Auditoría!");
    } catch (e: any) {
      alert("Error al guardar: " + e.message);
    } finally {
      setIsSaving(false);
    }
  };

  const blockProps = {
    fechaTexto,
    diaSemana,
    totalMenuEfectivo: autoCounts.menuCash,
    totalVeggieEfectivo: autoCounts.veggieCash,
    totalCeliacoEfectivo: autoCounts.celiacoCash,
    totalComensales: autoCounts.totalComensales,
    totalMpCaja: autoCounts.mpTotal,
    totalLotesConsumidos,
    bundleSales,
    responsablesVenta,
    state: sharedState,
    updateState: updateSharedState,
    updateManual: updateManualState
  };

  return (
    <div className="rendicion-wrapper">
      <div className="rendicion-actions screen-only" style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '20px' }}>
        <button 
          className="button" 
          style={{ background: hasSaved ? "#6b7280" : "#10b981", color: "white", padding: "10px 20px" }} 
          onClick={handleSaveDB} 
          disabled={isSaving}
        >
          {isSaving ? "Guardando y Generando PDF..." : hasSaved ? "✅ Turno Cerrado (Actualizar)" : "1. Cerrar Turno, Guardar y Generar PDF"}
        </button>
        
        <button 
          className="button primary" 
          style={{ padding: "10px 20px", opacity: hasSaved ? 1 : 0.5 }}
          onClick={() => window.print()} 
          disabled={!hasSaved}
        >
          2. Imprimir
        </button>
      </div>

      <div className="rendicion-page">
        <div className="rendicion-instance">
          <RendicionBlock {...blockProps} blockId="rendicion-original" />
        </div>

        <div className="rendicion-instance rendicion-copy">
          <RendicionBlock {...blockProps} />
        </div>
      </div>
    </div>
  );
};

export default RendicionPage;
