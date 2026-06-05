import React, { useEffect, useMemo, useState } from "react";
import { listenTodaySales, todayKey } from "../lib/sales";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db, storage } from "../firebase";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { useAuth } from "../state/AuthContext";

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
  totalMenuCaja: number;
  totalVeggieCaja: number;
  totalCeliacoCaja: number;
  totalMpCaja: number; // Automático desde la BD
  state: RendicionState;
  updateState: (newState: Partial<RendicionState>) => void;
  updateManual: (field: keyof RendicionState["manual"], value: number) => void;
};

const RendicionBlock: React.FC<BlockProps> = ({
  blockId,
  fechaTexto,
  diaSemana,
  totalMenuCaja,
  totalVeggieCaja,
  totalCeliacoCaja,
  totalMpCaja,
  state,
  updateState,
  updateManual
}) => {
  const { user } = useAuth();

  // ALGORITMO DE CAJA: Descuenta los MP automáticos y los extras manuales
  const menuCalculado = Math.max(0, totalMenuCaja - totalMpCaja - state.manual.acompMenuComensales - state.manual.subvencionados);
  const veggieCalculado = Math.max(0, totalVeggieCaja - state.manual.acompVeggieComensales);
  const celiacoCalculado = totalCeliacoCaja;

  const recMenu = state.valorMenu * menuCalculado;
  const recVeggie = state.valorVeggie * veggieCalculado;
  const recCeliaco = state.valorCeliaco * celiacoCalculado;
  
  const recAcompMenu = state.valorAcompMenu * state.manual.acompMenuComensales;
  const recAcompVeggie = state.valorAcompVeggie * state.manual.acompVeggieComensales;
  const recMp = state.valorMp * totalMpCaja;

  const totalComensales = totalMenuCaja + totalVeggieCaja + totalCeliacoCaja;
  const totalEfectivo = recMenu + recVeggie + recCeliaco + recAcompMenu + recAcompVeggie;
  const totalMp = recMp;

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
            {/* Campo Grisado Automático */}
            <td><input type="number" value={totalMpCaja} readOnly style={{ background: "#f3f4f6" }} /></td>
            <td className="num">{formatCurrency(recMp)}</td>
          </tr>

          <tr>
            <td>ACOMP. TERAP. MENU</td>
            <td><input className="editable-input" type="number" value={state.valorAcompMenu} onChange={(e) => updateState({ valorAcompMenu: Number(e.target.value) })} /></td>
            <td><input className="editable-input" type="number" value={state.manual.acompMenuComensales} onChange={(e) => updateManual("acompMenuComensales", Number(e.target.value))} /></td>
            <td className="num">{formatCurrency(recAcompMenu)}</td>
          </tr>

          <tr>
            <td>ACOMP. TERAP. VEGGIE</td>
            <td><input className="editable-input" type="number" value={state.valorAcompVeggie} onChange={(e) => updateState({ valorAcompVeggie: Number(e.target.value) })} /></td>
            <td><input className="editable-input" type="number" value={state.manual.acompVeggieComensales} onChange={(e) => updateManual("acompVeggieComensales", Number(e.target.value))} /></td>
            <td className="num">{formatCurrency(recAcompVeggie)}</td>
          </tr>

          <tr>
            <td style={{ color: "#3b82f6", fontWeight: "bold" }}>Extra sin cargo</td>
            <td>$ 0</td>
            {/* Vuelve a ser un campo editable manual */}
            <td><input className="editable-input" type="number" value={state.manual.subvencionados} onChange={(e) => updateManual("subvencionados", Number(e.target.value))} /></td>
            <td className="num">$ 0</td>
          </tr>
        </tbody>
      </table>

      <div className="rendicion-totales">
        <div>TOTAL DE COMENSALES: {totalComensales}</div>
        <div>TOTAL EFECTIVO: {formatCurrency(totalEfectivo)}</div>
        <div>TOTAL MERCADO PAGO: {formatCurrency(totalMp)}</div>
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
          RESPONSABLE: <strong>{user?.displayName || user?.email}</strong>
        </div>
        <div className="firma-line" style={{ borderBottom: '1px solid #000', width: '250px', marginBottom: 4 }} />
        <span style={{ fontSize: 10, color: '#666' }}>FIRMA Y ACLARACIÓN</span>
      </div>
    </div>
  );
};

const RendicionPage: React.FC = () => {
  const [rows, setRows] = useState<Row[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [hasSaved, setHasSaved] = useState(false); 
  
  const [sharedState, setSharedState] = useState<RendicionState>({
    valorMenu: 2500,
    valorVeggie: 2500,
    valorCeliaco: 2500,
    valorAcompMenu: 2500,
    valorAcompVeggie: 2500,
    valorMp: 2500,
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

  // FILTRO: Ignoramos los formales de Gabinete Social y contamos el resto
  const autoCounts = useMemo(() => {
    let menuPaid = 0, veggiePaid = 0, celiacoPaid = 0;
    let mpTotal = 0;

    rows.forEach((r: any) => {
      const memberId = (r.member?.id ?? "").trim();
      // Ignoramos anulados, los que no tienen ID, y a los subvencionados del Gabinete
      if (!r.voided && memberId !== "" && !r.isSubsidized) {
        
        if (r.itemType === "MENU") menuPaid++;
        if (r.itemType === "VEGGIE") veggiePaid++;
        if (r.itemType === "CELIACO") celiacoPaid++;

        if (r.paymentMethod === "MP") {
          mpTotal++;
        }
      }
    });

    return { menuPaid, veggiePaid, celiacoPaid, mpTotal };
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
      
      const menuCalculado = Math.max(0, autoCounts.menuPaid - autoCounts.mpTotal - sharedState.manual.acompMenuComensales - sharedState.manual.subvencionados);
      const veggieCalculado = Math.max(0, autoCounts.veggiePaid - sharedState.manual.acompVeggieComensales);
      const celiacoCalculado = autoCounts.celiacoPaid;

      const recMenu = sharedState.valorMenu * menuCalculado;
      const recVeggie = sharedState.valorVeggie * veggieCalculado;
      const recCeliaco = sharedState.valorCeliaco * celiacoCalculado;
      const recAcompMenu = sharedState.valorAcompMenu * sharedState.manual.acompMenuComensales;
      const recAcompVeggie = sharedState.valorAcompVeggie * sharedState.manual.acompVeggieComensales;
      const recMp = sharedState.valorMp * autoCounts.mpTotal;

      const totalComensales = autoCounts.menuPaid + autoCounts.veggiePaid + autoCounts.celiacoPaid;
      const totalEfectivo = recMenu + recVeggie + recCeliaco + recAcompMenu + recAcompVeggie;
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
        totales: {
          comensalesTotales: totalComensales,
          efectivoPesos: totalEfectivo,
          mpPesos: recMp,
          qtyEfectivo: qtyEfectivo,
          qtyMp: autoCounts.mpTotal,
          qtyExtraSinCargo: sharedState.manual.subvencionados
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
    totalMenuCaja: autoCounts.menuPaid,
    totalVeggieCaja: autoCounts.veggiePaid,
    totalCeliacoCaja: autoCounts.celiacoPaid,
    totalMpCaja: autoCounts.mpTotal,
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