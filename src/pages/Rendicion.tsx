import React, { useEffect, useMemo, useState } from "react";
import { listenTodaySales, todayKey } from "../lib/sales";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

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
};

const RendicionBlock: React.FC<BlockProps> = ({
  fechaTexto,
  diaSemana,
  totalMenuCaja,
  totalVeggieCaja,
  totalCeliacoCaja,
  showSaveButton
}) => {
  const [valorMenu, setValorMenu] = useState<number>(4000);
  const [valorVeggie, setValorVeggie] = useState<number>(4000);
  const [valorCeliaco, setValorCeliaco] = useState<number>(4000);
  const [valorAcompMenu, setValorAcompMenu] = useState<number>(4000);
  const [valorAcompVeggie, setValorAcompVeggie] = useState<number>(4000);
  const [valorMp, setValorMp] = useState<number>(2500);

  const [manual, setManual] = useState<ValoresManual>({
    mpComensales: 0,
    acompMenuComensales: 0,
    acompVeggieComensales: 0,
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
  // Usamos Math.max para evitar números negativos si el usuario tipea mal.
  
  const menuCalculado = Math.max(0, totalMenuCaja - manual.mpComensales - manual.acompMenuComensales);
  const veggieCalculado = Math.max(0, totalVeggieCaja - manual.acompVeggieComensales);
  const celiacoCalculado = totalCeliacoCaja;

  const recMenu = valorMenu * menuCalculado;
  const recVeggie = valorVeggie * veggieCalculado;
  const recCeliaco = valorCeliaco * celiacoCalculado;
  
  const recAcompMenu = valorAcompMenu * manual.acompMenuComensales;
  const recAcompVeggie = valorAcompVeggie * manual.acompVeggieComensales;
  const recMp = valorMp * manual.mpComensales;

  // El total de comensales ahora es la sumatoria pura de las viandas despachadas, 
  // ya que los inputs de MP/Acompañantes son solo re-clasificaciones financieras.
  const totalComensales = totalMenuCaja + totalVeggieCaja + totalCeliacoCaja;

  const totalEfectivo = recMenu + recVeggie + recCeliaco + recAcompMenu + recAcompVeggie;
  const totalMp = recMp;

  const formatCurrency = (n: number) => n === 0 ? "" : `$ ${n.toLocaleString("es-AR")}`;

  // Función que guarda las métricas de MP y Efectivo a la base de datos
  const handleSaveDB = async () => {
    setIsSaving(true);
    try {
      // Sumamos la cantidad de raciones cobradas en efectivo (descontando MP)
      const qtyEfectivo = menuCalculado + veggieCalculado + celiacoCalculado + manual.acompMenuComensales + manual.acompVeggieComensales;
      const qtyMp = manual.mpComensales;

      await setDoc(doc(db, "dayAgg", todayKey()), {
        payments: { cash: qtyEfectivo, mp: qtyMp },
        lastUpdated: serverTimestamp()
      }, { merge: true });

      alert("¡Rendición de medios de pago guardada en el sistema para Auditoría!");
    } catch (e: any) {
      alert("Error al guardar: " + e.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="rendicion-card">
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
            {/* Mostramos el valor calculado post-resta */}
            <td><input type="number" value={menuCalculado} readOnly /></td>
            <td className="num">{formatCurrency(recMenu)}</td>
          </tr>

          <tr>
            <td>VEGGIE</td>
            <td><input className="editable-input" type="number" value={valorVeggie} onChange={(e) => setValorVeggie(Number(e.target.value))} /></td>
            {/* Mostramos el valor calculado post-resta */}
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

      <div className="rendicion-firma">
        <span>FIRMA Y ACLARACION:</span>
        <div className="firma-line" />
      </div>

      {showSaveButton && (
        <div className="screen-only" style={{ marginTop: 20, textAlign: "center" }}>
          <button className="button" style={{ background: "#10b981" }} onClick={handleSaveDB} disabled={isSaving}>
            {isSaving ? "Guardando..." : "Guardar Totales de MP/Efectivo en Sistema"}
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
          // SOLO ventas de caja con socio real (Y QUE NO SEAN GRATIS)
          const memberId = (r.member?.id ?? "").trim();

          if (
            !r.voided &&
            !r.isSubsidized && // Filtramos los gratuitos
            memberId !== "" &&
            (r.itemType === "MENU" ||
              r.itemType === "VEGGIE" ||
              r.itemType === "CELIACO")
          ) {
            acc[r.itemType as "MENU" | "VEGGIE" | "CELIACO"]++;
          }

          return acc;
        },
        { MENU: 0, VEGGIE: 0, CELIACO: 0 } as Record<
          "MENU" | "VEGGIE" | "CELIACO",
          number
        >
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