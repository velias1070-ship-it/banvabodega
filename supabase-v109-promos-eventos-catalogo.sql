-- v109: catálogo de eventos de promo + auto-tag por pattern matching
--
-- Hoy ml_price_history.promo_name guarda lo que ML reporta literal.
-- Eso da nombres heterogéneos: "Dia de la mama 2026" (semántico),
-- "Oferta Banva Mayo" (temporal Banva), "C-MLC671506" (ID raw ML).
--
-- Sin un tag semántico común, no se puede preguntar "qué vendí en Día
-- Madre" agregando todas las ocurrencias.
--
-- Diseño:
--   1. Tabla promos_eventos (promo_name → evento_tag) — fuente de verdad
--      del mapping. Pre-pobla con auto-tag por regex y permite override
--      manual.
--   2. RPC auto_tag_promos_eventos() — re-aplica las reglas de pattern
--      matching sobre promo_names sin tag o con tag='auto' que no fue
--      overrideado. Idempotente.
--   3. Vista v_ml_price_history_con_evento — JOIN history con eventos.
--   4. Vista v_ventas_con_evento — JOIN ventas_ml_cache (promo_name_aplicada
--      post v108) con eventos.

CREATE TABLE IF NOT EXISTS promos_eventos (
  promo_name text PRIMARY KEY,
  evento_tag text NOT NULL,
  evento_subtag text,
  fuente_tag text NOT NULL DEFAULT 'auto' CHECK (fuente_tag IN ('auto','manual','override')),
  notas text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE promos_eventos IS 'Catálogo: cada promo_name observado en ml_price_history mapea a un evento_tag semántico (dia_madre, navidad, banva_periodica, ml_campaign_raw, etc). Permite agregaciones por evento.';
COMMENT ON COLUMN promos_eventos.evento_tag IS 'Tag canónico del evento. Ejemplos: dia_madre, dia_padre, navidad, black_friday, cyber, banva_periodica, segmento_producto, ml_campaign_raw, otra.';
COMMENT ON COLUMN promos_eventos.evento_subtag IS 'Sub-tag opcional (ej. mes para banva_periodica: "mayo", "abril"). NULL si no aplica.';
COMMENT ON COLUMN promos_eventos.fuente_tag IS 'auto = pattern matching, manual = lo agregaste tú, override = pisaste un auto manual.';

CREATE INDEX IF NOT EXISTS promos_eventos_evento_tag_idx ON promos_eventos(evento_tag);

-- Función helper: dado un promo_name, devuelve tag + subtag derivados.
-- Si retorna NULL, no encontró match.
CREATE OR REPLACE FUNCTION inferir_evento_promo(p_promo_name text)
RETURNS TABLE (evento_tag text, evento_subtag text) AS $$
BEGIN
  IF p_promo_name IS NULL THEN
    RETURN QUERY SELECT NULL::text, NULL::text;
    RETURN;
  END IF;
  -- Día de la madre
  IF p_promo_name ~* '\m(madre|mama|mamá|mom|mother)\M' THEN
    RETURN QUERY SELECT 'dia_madre'::text, NULLIF(substring(p_promo_name FROM '\m(\d{4})\M'), '')::text;
    RETURN;
  END IF;
  -- Día del padre
  IF p_promo_name ~* '\m(padre|papa|papá|dad|father)\M' THEN
    RETURN QUERY SELECT 'dia_padre'::text, NULLIF(substring(p_promo_name FROM '\m(\d{4})\M'), '')::text;
    RETURN;
  END IF;
  -- Navidad
  IF p_promo_name ~* '\m(navidad|xmas|christmas|noel)\M' THEN
    RETURN QUERY SELECT 'navidad'::text, NULLIF(substring(p_promo_name FROM '\m(\d{4})\M'), '')::text;
    RETURN;
  END IF;
  -- Cyber / Black Friday
  IF p_promo_name ~* '\m(black\s*friday|black|cyber\s*day|cyber|cybermonday)\M' THEN
    RETURN QUERY SELECT 'black_cyber'::text, NULLIF(substring(p_promo_name FROM '\m(\d{4})\M'), '')::text;
    RETURN;
  END IF;
  -- Hot Sale / Hot Day
  IF p_promo_name ~* '\m(hot\s*sale|hot\s*day)\M' THEN
    RETURN QUERY SELECT 'hot_sale'::text, NULLIF(substring(p_promo_name FROM '\m(\d{4})\M'), '')::text;
    RETURN;
  END IF;
  -- Promo BANVA periódica: "Oferta Banva <mes>"
  IF p_promo_name ~* '^oferta\s*banva' THEN
    RETURN QUERY SELECT 'banva_periodica'::text,
      lower(trim(substring(p_promo_name FROM '(?i)oferta\s+banva\s+(.+)$')));
    RETURN;
  END IF;
  -- Promo BANVA por segmento: "Oferta Sabanas", "Oferta Plumones", etc
  IF p_promo_name ~* '^oferta\s+\S+' AND p_promo_name !~* 'banva' THEN
    RETURN QUERY SELECT 'segmento_producto'::text,
      lower(trim(substring(p_promo_name FROM '(?i)oferta\s+(.+)$')));
    RETURN;
  END IF;
  -- IDs raw ML: C-MLC..., P-MLC..., MLC..., D-MLC...
  IF p_promo_name ~ '^[A-Z]+-?MLC[0-9]+$' OR p_promo_name ~ '^MLC[0-9]+$' THEN
    RETURN QUERY SELECT 'ml_campaign_raw'::text, NULL::text;
    RETURN;
  END IF;
  -- Default: tag genérico, debería revisarse manual
  RETURN QUERY SELECT 'otra'::text, NULL::text;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- RPC: auto-tagear todos los promo_name que aparezcan en ml_price_history
-- y no estén en promos_eventos (o estén con fuente_tag='auto' y un nuevo
-- match difiera). Idempotente.
CREATE OR REPLACE FUNCTION auto_tag_promos_eventos()
RETURNS TABLE(insertados int, actualizados int, sin_cambio int) AS $$
DECLARE
  rec RECORD;
  v_evento_tag text;
  v_evento_subtag text;
  ins int := 0;
  upd int := 0;
  same int := 0;
BEGIN
  -- Para cada promo_name distinto en history (excluyendo NULLs)
  FOR rec IN
    SELECT DISTINCT ph.promo_name
    FROM ml_price_history ph
    WHERE ph.promo_name IS NOT NULL AND ph.promo_name <> ''
  LOOP
    SELECT * INTO v_evento_tag, v_evento_subtag FROM inferir_evento_promo(rec.promo_name);
    -- ¿Ya existe en promos_eventos?
    DECLARE
      v_existing RECORD;
    BEGIN
      SELECT * INTO v_existing FROM promos_eventos WHERE promo_name = rec.promo_name;
      IF NOT FOUND THEN
        INSERT INTO promos_eventos (promo_name, evento_tag, evento_subtag, fuente_tag)
        VALUES (rec.promo_name, v_evento_tag, v_evento_subtag, 'auto');
        ins := ins + 1;
      ELSE
        -- Si fuente es 'manual' u 'override', NO pisamos.
        IF v_existing.fuente_tag IN ('manual', 'override') THEN
          same := same + 1;
        ELSIF v_existing.evento_tag IS DISTINCT FROM v_evento_tag
           OR v_existing.evento_subtag IS DISTINCT FROM v_evento_subtag THEN
          UPDATE promos_eventos SET evento_tag = v_evento_tag, evento_subtag = v_evento_subtag, updated_at = now()
          WHERE promo_name = rec.promo_name;
          upd := upd + 1;
        ELSE
          same := same + 1;
        END IF;
      END IF;
    END;
  END LOOP;
  RETURN QUERY SELECT ins, upd, same;
END;
$$ LANGUAGE plpgsql;

-- Vista: ml_price_history enriquecido con evento_tag/subtag
CREATE OR REPLACE VIEW v_ml_price_history_con_evento AS
SELECT h.*, e.evento_tag, e.evento_subtag, e.fuente_tag
FROM ml_price_history h
LEFT JOIN promos_eventos e ON e.promo_name = h.promo_name;

COMMENT ON VIEW v_ml_price_history_con_evento IS 'ml_price_history con tag semántico de evento (LEFT JOIN, NULL si promo_name no tagueado).';

-- Vista: ventas con evento_tag (post v108 que agregó promo_name_aplicada)
CREATE OR REPLACE VIEW v_ventas_con_evento AS
SELECT v.*, e.evento_tag, e.evento_subtag, e.fuente_tag
FROM ventas_ml_cache v
LEFT JOIN promos_eventos e ON e.promo_name = v.promo_name_aplicada
WHERE v.anulada = false;

COMMENT ON VIEW v_ventas_con_evento IS 'Ventas filtradas no-anuladas con evento_tag de la promo aplicada (LEFT JOIN, NULL si promo no tagueada o pre-v108).';

-- Backfill inicial: ejecutar el auto-tag sobre todos los promo_names ya capturados.
SELECT * FROM auto_tag_promos_eventos();
