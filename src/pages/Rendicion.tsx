import React, { useEffect, useMemo, useState } from "react";
import { listenTodaySales, todayKey } from "../lib/sales";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db, storage } from "../firebase";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { useAuth } from "../state/AuthContext";

type Row = any;

// NUEVO: Definimos la estructura de todos los estados compartidos
export type RendicionState = {
  valorMenu: number;
  valorVeggie: number;
  valorCeliaco: number;
  valorAcompMenu: number;
  valorAcompVeggie: number;
  valorMp: number;
  manual: {
    mpComensales: number;
    acompMenuComensales: number;
    acompVeggieComensales: number;
    subvencionados: number;
  };
  observaciones: string;
};

// NUEVO: Ampliamos las props para recibir el estado y la función para actualizarlo
type BlockProps = {
  fechaTexto: string;
  diaSemana: string;
  totalMenuCaja: number;
  totalVeggieCaja: number;
  totalCeliacoCaja: number;
  showSaveButton?: boolean;
  state: RendicionState;
  updateState: (newState: Partial<RendicionState>) => void;
  updateManual: (field: keyof RendicionState["manual"], value: number) => void;
};

const RendicionBlock: React.FC<BlockProps> = ({
  fechaTexto,
  diaSemana,
  totalMenuCaja,
  totalVeggieCaja,
  totalCeliacoCaja,
  showSaveButton,
  state,           // RECIBIMOS EL ESTADO COMPARTIDO
  updateState,     // RECIBIMOS LAS FUNCIONES PARA ACTUALIZAR
  updateManual
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const { user } = useAuth();

  // Usamos los valores del estado central
  const menuCalculado = Math.max(0, totalMenuCaja - state.manual.mpComensales - state.manual.acompMenuComensales - state.manual.subvencionados);
  const veggieCalculado = Math.max(0, totalVeggieCaja - state.manual.acompVeggieComensales);
  const celiacoCalculado = totalCeliacoCaja;

  const recMenu = state.valorMenu * menuCalculado;
  const recVeggie = state.valorVeggie * veggieCalculado;
  const recCeliaco = state.valorCeliaco * celiacoCalculado;
  
  const recAcompMenu = state.valorAcompMenu * state.manual.acompMenuComensales;
  const recAcompVeggie = state.valorAcompVeggie * state.manual.acompVeggieComensales;
  const recMp = state.valorMp * state.manual.mpComensales;

  const totalComensales = totalMenuCaja + totalVeggieCaja + totalCeliacoCaja;
  const totalEfectivo = recMenu + recVeggie + recCeliaco + recAcompMenu + recAcompVeggie;
  const totalMp = recMp;

  const formatCurrency = (n: number) => n === 0 ? "" : `$ ${n.toLocaleString("es-AR")}`;

  const handleSaveDB = async () => {
    setIsSaving(true);
    try {
      const element = document.getElementById("rendicion-original");
      if (!element) throw new Error("No se encontró la tabla para imprimir");
      
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

      const qtyEfectivo = menuCalculado + veggieCalculado + celiacoCalculado + state.manual.acompMenuComensales + state.manual.acompVeggieComensales;
      await setDoc(doc(db, "dayAgg", todayKey()), {
        payments: { cash: qtyEfectivo, mp: state.manual.mpComensales, subvencionados: state.manual.subvencionados },
        lastUpdated: serverTimestamp()
      }, { merge: true });

      await setDoc(doc(db, "rendiciones_audit", todayKey()), {
        dateKey: todayKey(),
        timestamp: serverTimestamp(),
        pdfUrl: pdfUrl,
        observaciones: state.observaciones,
        totales: {
          comensalesTotales: totalComensales,
          efectivoPesos: totalEfectivo,
          mpPesos: totalMp,
          qtyEfectivo: qtyEfectivo,
          qtyMp: state.manual.mpComensales,
          qtySubvencionados: state.manual.subvencionados
        }
      });

      alert("✅ ¡Rendición guardada exitosamente y PDF generado para Auditoría!");
    } catch (e: any) {
      alert("Error al guardar: " + e.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="rendicion-card" id={showSaveButton ? "rendicion-original" : ""}>
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
            <td><input className="editable-input" type="number" value={state.manual.mpComensales} onChange={(e) => updateManual("mpComensales", Number(e.target.value))} /></td>
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

      {showSaveButton && (
        <div className="screen-only" style={{ marginTop: 20, textAlign: "center" }}>
          <button className="button" style={{ background: "#10b981" }} onClick={handleSaveDB} disabled={isSaving}>
            {isSaving ? "Generando PDF y Guardando..." : "Cerrar Turno, Guardar y Generar PDF"}
          </button>
        </div>
      )}
    </div>
  );
};

const RendicionPage: React.FC = () => {
  const [rows, setRows] = useState<Row[]>([]);
  
  // NUEVO: El estado maestro vive aquí en el padre
  const [sharedState, setSharedState] = useState<RendicionState>({
    valorMenu: 2500,
    valorVeggie: 2500,
    valorCeliaco: 2500,
    valorAcompMenu: 2500,
    valorAcompVeggie: 2500,
    valorMp: 2500,
    manual: {
      mpComensales: 0,
      acompMenuComensales: 0,
      acompVeggieComensales: 0,
      subvencionados: 0,
    },
    observaciones: "",
  });

  const updateSharedState = (newState: Partial<RendicionState>) => {
    setSharedState(prev => ({ ...prev, ...newState }));
  };

  const updateManualState = (field: keyof RendicionState["manual"], value: number) => {
    const safeValue = isNaN(value) ? 0 : value;
    setSharedState(prev => ({
      ...prev,
      manual: { ...prev.manual, [field]: safeValue }
    }));
  };

  useEffect(() => listenTodaySales(setRows), []);

  const viandaCounts = useMemo(
    () =>
      rows.reduce(
        (acc, r: any) => {
          const memberId = (r.member?.id ?? "").trim();
          if (
            !r.voided &&
            !r.isSubsidized &&
            memberId !== "" &&
            (r.itemType === "MENU" ||
              r.itemType === "VEGGIE" ||
              r.itemType === "CELIACO")
          ) {
            acc[r.itemType as "MENU" | "VEGGIE" | "CELIACO"]++;
          }
          return acc;
        },
        { MENU: 0, VEGGIE: 0, CELIACO: 0 } as Record<"MENU" | "VEGGIE" | "CELIACO", number>
      ),
    [rows]
  );

  const now = new Date();
  const fechaTexto = now.toLocaleDateString("es-AR");
  const dias = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  const diaSemana = dias[now.getDay()];

  const blockProps = {
    fechaTexto,
    diaSemana,
    totalMenuCaja: viandaCounts.MENU,
    totalVeggieCaja: viandaCounts.VEGGIE,
    totalCeliacoCaja: viandaCounts.CELIACO,
    state: sharedState,           // PASAMOS EL ESTADO
    updateState: updateSharedState, // PASAMOS EL ACTUALIZADOR
    updateManual: updateManualState // PASAMOS EL ACTUALIZADOR MANUAL
  };

  return (
    <div className="rendicion-wrapper">
      <div className="rendicion-actions screen-only">
        <button className="button primary" onClick={() => window.print()}>
          Imprimir
        </button>
      </div>

      <div className="rendicion-page">
        <div className="rendicion-instance">
          <RendicionBlock {...blockProps} showSaveButton={true} />
        </div>

        <div className="rendicion-instance rendicion-copy">
          <RendicionBlock {...blockProps} showSaveButton={false} />
        </div>
      </div>
    </div>
  );
};

export default RendicionPage;