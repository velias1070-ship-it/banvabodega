-- v84 — IRA tracking en conteos cíclicos
-- Manual de inventarios Parte2 §5.6.2 línea 144: "IRA (Inventory Record Accuracy):
-- % de ubicaciones donde el conteo físico = sistema, dentro de tolerancia."
--
-- Se persiste en el row del conteo al cerrarlo. Snapshot inmutable: si después
-- cambian las tolerancias o el algoritmo, los conteos viejos quedan con su valor
-- al cierre (auditable).

ALTER TABLE conteos
  ADD COLUMN IF NOT EXISTS lineas_total int,
  ADD COLUMN IF NOT EXISTS lineas_ok int,
  ADD COLUMN IF NOT EXISTS lineas_diff int,
  ADD COLUMN IF NOT EXISTS ira_pct numeric(5,2);

COMMENT ON COLUMN conteos.lineas_total IS 'Total de líneas contadas (excluye PENDIENTE).';
COMMENT ON COLUMN conteos.lineas_ok    IS 'Líneas con stock_contado = stock_sistema al momento de cerrar.';
COMMENT ON COLUMN conteos.lineas_diff  IS 'Líneas con diferencia (stock_contado != stock_sistema).';
COMMENT ON COLUMN conteos.ira_pct      IS 'Inventory Record Accuracy = lineas_ok / lineas_total * 100. Benchmark manual: >95%.';
