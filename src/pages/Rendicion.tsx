import React, { useEffect, useMemo, useState } from "react";
import { listenTodaySales, todayKey } from "../lib/sales";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db, storage } from "../firebase"; // Asegurate de importar storage
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { useAuth } from "../state/AuthContext";

type Row = any;

type BlockProps = {
  fechaTexto: string;
  diaSemana: string;
  totalMenuCaja: number;
  totalVeggieCaja: number;
  totalCeliacoCaja: number;
  showSaveButton?: boolean;
};

type ValoresManual = {
  mpComensales: number;
  acompMenuComensales: number;
  acompVeggieComensales: number;
  subvencionados: number; // NUEVO CAMPO
};

const RendicionBlock: React.FC<BlockProps> = ({
  fechaTexto,
  diaSemana,
  totalMenuCaja,
  totalVeggieCaja,
  totalCeliacoCaja,
  showSaveButton
}) => {
  const [valorMenu, setValorMenu] = useState<number>(2500);
  const [valorVeggie, setValorVeggie] = useState<number>(2500);
  const [valorCeliaco, setValorCeliaco] = useState<number>(2500);
  const [valorAcompMenu, setValorAcompMenu] = useState<number>(2500);
  const [valorAcompVeggie, setValorAcompVeggie] = useState<number>(2500);
  const [valorMp, setValorMp] = useState<number>(2500);

  const [manual, setManual] = useState<ValoresManual>({
    mpComensales: 0,
    acompMenuComensales: 0,
    acompVeggieComensales: 0,
    subvencionados: 0,
  });

  const [observaciones, setObservaciones] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const handleManualChange = (field: keyof ValoresManual, value: string) => {
    const num = Number(value);
    setManual((prev) => ({ ...prev, [field]: isNaN(num) ? 0 : num }));
  };

  // ==========================================
  // LÓGICA INTELIGENTE DE BALANCE DE CAJA
  // ==========================================
  // Restamos de las cajas originales los valores ingresados manualmente.
  // NUEVO: Ahora también restamos los subvencionados del menú calculado.
  const menuCalculado = Math.max(0, totalMenuCaja - manual.mpComensales - manual.acompMenuComensales - manual.subvencionados);
  const veggieCalculado = Math.max(0, totalVeggieCaja - manual.acompVeggieComensales);
  const celiacoCalculado = totalCeliacoCaja;

  const recMenu = valorMenu * menuCalculado;
  const recVeggie = valorVeggie * veggieCalculado;
  const recCeliaco = valorCeliaco * celiacoCalculado;
  
  const recAcompMenu = valorAcompMenu * manual.acompMenuComensales;
  const recAcompVeggie = valorAcompVeggie * manual.acompVeggieComensales;
  const recMp = valorMp * manual.mpComensales;

  const { user } = useAuth();
  // El total de comensales es la sumatoria pura de viandas despachadas (Incluye gratis)
  const totalComensales = totalMenuCaja + totalVeggieCaja + totalCeliacoCaja;

  const totalEfectivo = recMenu + recVeggie + recCeliaco + recAcompMenu + recAcompVeggie;
  const totalMp = recMp;

  const formatCurrency = (n: number) => n === 0 ? "" : `$ ${n.toLocaleString("es-AR")}`;

  const handleSaveDB = async () => {
    setIsSaving(true);
    try {
      // 1. GENERAMOS EL PDF (Foto de la pantalla original)
      const element = document.getElementById("rendicion-original");
      if (!element) throw new Error("No se encontró la tabla para imprimir");
      
      const canvas = await html2canvas(element, { scale: 2 }); // Scale 2 para alta calidad
      const imgData = canvas.toDataURL("image/png");
      
      const pdf = new jsPDF("p", "mm", "a4");
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      
      pdf.addImage(imgData, "PNG", 0, 10, pdfWidth, pdfHeight);
      const pdfBlob = pdf.output("blob");

      // 2. SUBIMOS EL PDF A STORAGE
      const uniqueName = `rendicion_${todayKey()}_${Date.now()}.pdf`;
      const storageRef = ref(storage, `rendiciones/${uniqueName}`);
      await uploadBytes(storageRef, pdfBlob);
      const pdfUrl = await getDownloadURL(storageRef);

      // 3. ACTUALIZAMOS DAY_AGG (Métricas operativas)
      const qtyEfectivo = menuCalculado + veggieCalculado + celiacoCalculado + manual.acompMenuComensales + manual.acompVeggieComensales;
      await setDoc(doc(db, "dayAgg", todayKey()), {
        payments: { cash: qtyEfectivo, mp: manual.mpComensales, subvencionados: manual.subvencionados },
        lastUpdated: serverTimestamp()
      }, { merge: true });

      // 4. GUARDAMOS EN LA TABLA DE AUDITORÍA
      await setDoc(doc(db, "rendiciones_audit", todayKey()), {
        dateKey: todayKey(),
        timestamp: serverTimestamp(),
        pdfUrl: pdfUrl,
        observaciones: observaciones,
        totales: {
          comensalesTotales: totalComensales,
          efectivoPesos: totalEfectivo,
          mpPesos: totalMp,
          qtyEfectivo: qtyEfectivo,
          qtyMp: manual.mpComensales,
          qtySubvencionados: manual.subvencionados
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
            <td><input className="editable-input" type="number" value={valorMenu} onChange={(e) => setValorMenu(Number(e.target.value))} /></td>
            <td><input type="number" value={menuCalculado} readOnly /></td>
            <td className="num">{formatCurrency(recMenu)}</td>
          </tr>

          <tr>
            <td>VEGGIE</td>
            <td><input className="editable-input" type="number" value={valorVeggie} onChange={(e) => setValorVeggie(Number(e.target.value))} /></td>
            <td><input type="number" value={veggieCalculado} readOnly /></td>
            <td className="num">{formatCurrency(recVeggie)}</td>
          </tr>

          <tr>
            <td>CELIACO</td>
            <td><input className="editable-input" type="number" value={valorCeliaco} onChange={(e) => setValorCeliaco(Number(e.target.value))} /></td>
            <td><input type="number" value={celiacoCalculado} readOnly /></td>
            <td className="num">{formatCurrency(recCeliaco)}</td>
          </tr>

          <tr>
            <td>PAGOS MERCADO PAGO</td>
            <td><input className="editable-input" type="number" value={valorMp} onChange={(e) => setValorMp(Number(e.target.value))} /></td>
            <td><input className="editable-input" type="number" value={manual.mpComensales} onChange={(e) => handleManualChange("mpComensales", e.target.value)} /></td>
            <td className="num">{formatCurrency(recMp)}</td>
          </tr>

          <tr>
            <td>ACOMP. TERAP. MENU</td>
            <td><input className="editable-input" type="number" value={valorAcompMenu} onChange={(e) => setValorAcompMenu(Number(e.target.value))} /></td>
            <td><input className="editable-input" type="number" value={manual.acompMenuComensales} onChange={(e) => handleManualChange("acompMenuComensales", e.target.value)} /></td>
            <td className="num">{formatCurrency(recAcompMenu)}</td>
          </tr>

          <tr>
            <td>ACOMP. TERAP. VEGGIE</td>
            <td><input className="editable-input" type="number" value={valorAcompVeggie} onChange={(e) => setValorAcompVeggie(Number(e.target.value))} /></td>
            <td><input className="editable-input" type="number" value={manual.acompVeggieComensales} onChange={(e) => handleManualChange("acompVeggieComensales", e.target.value)} /></td>
            <td className="num">{formatCurrency(recAcompVeggie)}</td>
          </tr>

          {/* NUEVO CAMPO: SUBVENCIONADOS */}
          <tr>
            <td style={{ color: "#3b82f6", fontWeight: "bold" }}>Extra sin cargo</td>
            <td>$ 0</td>
            <td><input className="editable-input" type="number" value={manual.subvencionados} onChange={(e) => handleManualChange("subvencionados", e.target.value)} /></td>
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
          value={observaciones}
          onChange={(e) => setObservaciones(e.target.value)}
        />
      </div>

      {/* SECCIÓN DE FIRMA ACTUALIZADA */}
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

  useEffect(() => listenTodaySales(setRows), []);

  const viandaCounts = useMemo(
    () =>
      rows.reduce(
        (acc, r: any) => {
          const memberId = (r.member?.id ?? "").trim();

          if (
            !r.voided &&
            // ELIMINAMOS !r.isSubsidized para que los cuente en el físico
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