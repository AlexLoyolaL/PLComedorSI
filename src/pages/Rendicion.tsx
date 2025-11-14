import React, { useEffect, useMemo, useState } from "react";
import { listenTodaySales } from "../lib/sales";

type Row = any;

type BlockProps = {
  fechaTexto: string;
  diaSemana: string;
  totalMenuCaja: number;
  totalVeggieCaja: number;
  totalCeliacoCaja: number;
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
}) => {
  const [valorMenu, setValorMenu] = useState<number>(1500);
  const [valorVeggie, setValorVeggie] = useState<number>(1500);
  const [valorCeliaco, setValorCeliaco] = useState<number>(1500);
  const [valorAcompMenu, setValorAcompMenu] = useState<number>(1550);
  const [valorAcompVeggie, setValorAcompVeggie] = useState<number>(1550);
  const [valorMp, setValorMp] = useState<number>(1500);

  const [manual, setManual] = useState<ValoresManual>({
    mpComensales: 0,
    acompMenuComensales: 0,
    acompVeggieComensales: 0,
  });

  const [observaciones, setObservaciones] = useState("");

  const handleManualChange = (field: keyof ValoresManual, value: string) => {
    const num = Number(value);
    setManual((prev) => ({ ...prev, [field]: isNaN(num) ? 0 : num }));
  };

  const recMenu = valorMenu * totalMenuCaja;
  const recVeggie = valorVeggie * totalVeggieCaja;
  const recCeliaco = valorCeliaco * totalCeliacoCaja;
  const recAcompMenu = valorAcompMenu * manual.acompMenuComensales;
  const recAcompVeggie = valorAcompVeggie * manual.acompVeggieComensales;
  const recMp = valorMp * manual.mpComensales;

  const totalComensales =
    totalMenuCaja +
    totalVeggieCaja +
    totalCeliacoCaja +
    manual.acompMenuComensales +
    manual.acompVeggieComensales +
    manual.mpComensales;

  const totalEfectivo =
    recMenu + recVeggie + recCeliaco + recAcompMenu + recAcompVeggie;

  const totalMp = recMp;

  const formatCurrency = (n: number) =>
    n === 0 ? "" : `$ ${n.toLocaleString("es-AR")}`;

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
            <td><input type="number" value={totalMenuCaja} readOnly /></td>
            <td className="num">{formatCurrency(recMenu)}</td>
          </tr>

          <tr>
            <td>VEGGIE</td>
            <td><input className="editable-input" type="number" value={valorVeggie} onChange={(e) => setValorVeggie(Number(e.target.value))} /></td>
            <td><input type="number" value={totalVeggieCaja} readOnly /></td>
            <td className="num">{formatCurrency(recVeggie)}</td>
          </tr>

          <tr>
            <td>CELIACO</td>
            <td><input className="editable-input" type="number" value={valorCeliaco} onChange={(e) => setValorCeliaco(Number(e.target.value))} /></td>
            <td><input type="number" value={totalCeliacoCaja} readOnly /></td>
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
          // SOLO ventas de caja con socio real
          const memberId = (r.member?.id ?? "").trim();

          if (
            !r.voided &&
            memberId !== "" && // excluye las cargas sin socio (AdminViandas)
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
          <RendicionBlock {...blockProps} />
        </div>

        <div className="rendicion-instance rendicion-copy">
          <RendicionBlock {...blockProps} />
        </div>
      </div>
    </div>
  );
};

export default RendicionPage;
