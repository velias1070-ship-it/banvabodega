-- v44: Prevenir duplicados en rcv_compras cuando el SII reporta la misma factura
-- en meses distintos (ej. mismo folio en 202603 y 202604).
--
-- El UNIQUE existente incluye `periodo`, así que el upsert no deduplica entre meses.
-- Un trigger BEFORE INSERT/UPDATE normaliza `periodo` al mes de `fecha_docto`,
-- garantizando que la misma factura siempre caiga en la misma clave única.
--
-- Limpieza previa: ejecutada vía REST API el 2026-04-11 (14 filas duplicadas del
-- periodo 202604 borradas, conciliación del folio 17787312 re-apuntada a la fila
-- de 202603 antes del borrado).

CREATE OR REPLACE FUNCTION rcv_compras_normalizar_periodo()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.fecha_docto IS NOT NULL THEN
    NEW.periodo := to_char(NEW.fecha_docto, 'YYYYMM');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rcv_compras_normalizar_periodo ON rcv_compras;

CREATE TRIGGER trg_rcv_compras_normalizar_periodo
BEFORE INSERT OR UPDATE ON rcv_compras
FOR EACH ROW
EXECUTE FUNCTION rcv_compras_normalizar_periodo();
