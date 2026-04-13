// Tarifas oficiales de envío ML Chile publicadas el 2026-04-13.
// Fuente: https://www.mercadolibre.cl/ayuda/nuevos-costos-envio-vendedores-reputacion-verde-sin-reputacion_48392
// Aplica a vendedores MercadoLíderes / reputación verde / sin reputación.
// ML factura por el mayor entre peso físico y peso volumétrico.
// Reputación verde: 50% off sobre la columna "caro" (precio >= $19.990).
// Los mismos valores están en la tabla ml_shipping_tariffs de Supabase (v47).

export type TariffTier = {
  peso_hasta_gr: number;
  label: string;
  costo_barato: number; // precio < $9.990
  costo_medio: number;  // precio $9.990 a $19.989
  costo_caro: number;   // precio >= $19.990
};

export const ML_SHIPPING_TARIFFS: TariffTier[] = [
  { peso_hasta_gr: 300,        label: "Hasta 0,3 kg",     costo_barato:  800, costo_medio:  1000, costo_caro:  3050 },
  { peso_hasta_gr: 500,        label: "0,3 a 0,5 kg",     costo_barato:  810, costo_medio:  1020, costo_caro:  3150 },
  { peso_hasta_gr: 1000,       label: "0,5 a 1 kg",       costo_barato:  830, costo_medio:  1040, costo_caro:  3250 },
  { peso_hasta_gr: 1500,       label: "1 a 1,5 kg",       costo_barato:  850, costo_medio:  1060, costo_caro:  3400 },
  { peso_hasta_gr: 2000,       label: "1,5 a 2 kg",       costo_barato:  870, costo_medio:  1080, costo_caro:  3600 },
  { peso_hasta_gr: 3000,       label: "2 a 3 kg",         costo_barato:  900, costo_medio:  1100, costo_caro:  3950 },
  { peso_hasta_gr: 4000,       label: "3 a 4 kg",         costo_barato: 1040, costo_medio:  1280, costo_caro:  4550 },
  { peso_hasta_gr: 5000,       label: "4 a 5 kg",         costo_barato: 1180, costo_medio:  1460, costo_caro:  4900 },
  { peso_hasta_gr: 6000,       label: "5 a 6 kg",         costo_barato: 1330, costo_medio:  1640, costo_caro:  5200 },
  { peso_hasta_gr: 8000,       label: "6 a 8 kg",         costo_barato: 1470, costo_medio:  1820, costo_caro:  5800 },
  { peso_hasta_gr: 10000,      label: "8 a 10 kg",        costo_barato: 1590, costo_medio:  1990, costo_caro:  6200 },
  { peso_hasta_gr: 15000,      label: "10 a 15 kg",       costo_barato: 1740, costo_medio:  2290, costo_caro:  7200 },
  { peso_hasta_gr: 20000,      label: "15 a 20 kg",       costo_barato: 1890, costo_medio:  2590, costo_caro:  8500 },
  { peso_hasta_gr: 25000,      label: "20 a 25 kg",       costo_barato: 2040, costo_medio:  2890, costo_caro: 10000 },
  { peso_hasta_gr: 30000,      label: "25 a 30 kg",       costo_barato: 2190, costo_medio:  3190, costo_caro: 13050 },
  { peso_hasta_gr: 40000,      label: "30 a 40 kg",       costo_barato: 2390, costo_medio:  3590, costo_caro: 15000 },
  { peso_hasta_gr: 50000,      label: "40 a 50 kg",       costo_barato: 2590, costo_medio:  3990, costo_caro: 17300 },
  { peso_hasta_gr: 60000,      label: "50 a 60 kg",       costo_barato: 2790, costo_medio:  4390, costo_caro: 19000 },
  { peso_hasta_gr: 70000,      label: "60 a 70 kg",       costo_barato: 2990, costo_medio:  4790, costo_caro: 20000 },
  { peso_hasta_gr: 80000,      label: "70 a 80 kg",       costo_barato: 3190, costo_medio:  5190, costo_caro: 22300 },
  { peso_hasta_gr: 90000,      label: "80 a 90 kg",       costo_barato: 3390, costo_medio:  5590, costo_caro: 24200 },
  { peso_hasta_gr: 100000,     label: "90 a 100 kg",      costo_barato: 3590, costo_medio:  5990, costo_caro: 26300 },
  { peso_hasta_gr: 110000,     label: "100 a 110 kg",     costo_barato: 3790, costo_medio:  6390, costo_caro: 28400 },
  { peso_hasta_gr: 120000,     label: "110 a 120 kg",     costo_barato: 3990, costo_medio:  6790, costo_caro: 31600 },
  { peso_hasta_gr: 130000,     label: "120 a 130 kg",     costo_barato: 4190, costo_medio:  7190, costo_caro: 34900 },
  { peso_hasta_gr: 140000,     label: "130 a 140 kg",     costo_barato: 4390, costo_medio:  7590, costo_caro: 38400 },
  { peso_hasta_gr: 150000,     label: "140 a 150 kg",     costo_barato: 4590, costo_medio:  7990, costo_caro: 41600 },
  { peso_hasta_gr: 175000,     label: "150 a 175 kg",     costo_barato: 4790, costo_medio:  8390, costo_caro: 47400 },
  { peso_hasta_gr: 200000,     label: "175 a 200 kg",     costo_barato: 4990, costo_medio:  8790, costo_caro: 55600 },
  { peso_hasta_gr: 225000,     label: "200 a 225 kg",     costo_barato: 5190, costo_medio:  9190, costo_caro: 63900 },
  { peso_hasta_gr: 250000,     label: "225 a 250 kg",     costo_barato: 5390, costo_medio:  9590, costo_caro: 70900 },
  { peso_hasta_gr: 275000,     label: "250 a 275 kg",     costo_barato: 5590, costo_medio:  9990, costo_caro: 78400 },
  { peso_hasta_gr: 300000,     label: "275 a 300 kg",     costo_barato: 5790, costo_medio: 10390, costo_caro: 85900 },
  { peso_hasta_gr: Number.MAX_SAFE_INTEGER, label: "Más de 300 kg", costo_barato: 5990, costo_medio: 10990, costo_caro: 93400 },
];

export type ColumnaPrecio = "barato" | "medio" | "caro";

export function columnaPorPrecio(precio: number): ColumnaPrecio {
  if (precio < 9990)  return "barato";
  if (precio < 19990) return "medio";
  return "caro";
}

export function tramoPorPeso(pesoGr: number): TariffTier {
  const p = Math.max(0, pesoGr || 0);
  return ML_SHIPPING_TARIFFS.find(t => t.peso_hasta_gr >= p) || ML_SHIPPING_TARIFFS[ML_SHIPPING_TARIFFS.length - 1];
}

export function calcularCostoEnvioML(pesoGr: number, precio: number): number {
  const tramo = tramoPorPeso(pesoGr);
  const col = columnaPorPrecio(precio);
  if (col === "barato") return tramo.costo_barato;
  if (col === "medio")  return tramo.costo_medio;
  return tramo.costo_caro;
}

export type MargenInput = {
  precio: number;
  costoBruto: number;
  pesoGr: number;
  comisionPct: number; // ej: 14 para Clásica plumones, 16 para almohadas
};

export type MargenResult = {
  precio: number;
  comision: number;
  envio: number;
  margen: number;
  margenPct: number;
  columna: ColumnaPrecio;
};

export function calcularMargen(i: MargenInput): MargenResult {
  const comision = Math.round(i.precio * (i.comisionPct / 100));
  const envio = calcularCostoEnvioML(i.pesoGr, i.precio);
  const margen = i.precio - comision - envio - i.costoBruto;
  const margenPct = i.precio > 0 ? (margen / i.precio) * 100 : 0;
  return { precio: i.precio, comision, envio, margen, margenPct, columna: columnaPorPrecio(i.precio) };
}

export type CurvaRow = MargenResult & {
  esActual?: boolean;
  esSweetSpotMedio?: boolean;  // mejor margen absoluto bajo $19.990
  esDeadZone?: boolean;        // margen < sweetSpotMedio y precio >= $19.990
  esBreakEven?: boolean;       // primer precio >= $19.990 donde margen supera sweetSpotMedio
};

export type CurvaInput = Omit<MargenInput, "precio"> & {
  precioActual: number;
  extraPoints?: number[]; // price points adicionales a incluir
};

// Genera ~25 price points representativos entre $5k y $80k cubriendo tramos bajos,
// los thresholds críticos ($9.990 y $19.990) y zonas altas. Agrega el precio actual.
export function generarCurvaMargen(i: CurvaInput): CurvaRow[] {
  const basePoints = [
    4990, 6990, 8990, 9980,  // barato
    9990, 12990, 14990, 17990, 18990, 19980, // medio (con thresholds)
    19990, 22990, 24990, 26990, 28990, 31990, 34990, 39990, 44990, 49990, 59990, 69990, 79990, // caro
  ];
  const points = Array.from(new Set([...basePoints, i.precioActual, ...(i.extraPoints || [])]))
    .filter(p => p > 0)
    .sort((a, b) => a - b);

  const rows: CurvaRow[] = points.map(precio => ({
    ...calcularMargen({ ...i, precio }),
    esActual: precio === i.precioActual,
  }));

  // Sweet spot bajo threshold: mejor margen con precio < 19990
  const bajoThreshold = rows.filter(r => r.precio < 19990);
  let sweetSpotMedio: CurvaRow | undefined;
  if (bajoThreshold.length > 0) {
    sweetSpotMedio = bajoThreshold.reduce((best, r) => r.margen > best.margen ? r : best, bajoThreshold[0]);
    sweetSpotMedio.esSweetSpotMedio = true;
  }

  // Dead zone: precios >= 19990 cuyo margen es menor al sweet spot bajo threshold
  // Break-even: primer precio >= 19990 donde se supera el sweet spot
  if (sweetSpotMedio) {
    const umbral = sweetSpotMedio.margen;
    let breakEvenMarcado = false;
    for (const r of rows) {
      if (r.precio < 19990) continue;
      if (r.margen < umbral) {
        r.esDeadZone = true;
      } else if (!breakEvenMarcado) {
        r.esBreakEven = true;
        breakEvenMarcado = true;
      }
    }
  }

  return rows;
}

// Formateador CLP sin decimales
export function fmtCLP(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(Math.round(n));
  return sign + "$" + abs.toLocaleString("es-CL");
}
