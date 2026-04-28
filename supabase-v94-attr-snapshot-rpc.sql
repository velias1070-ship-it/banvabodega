-- v94: RPC upsert_attr_snapshot_batch
-- Bypasea el bug de schema cache de PostgREST que rechaza upserts directos
-- a ml_item_attr_snapshot desde supabase-js. Usado por /api/ml/attr-watch.

CREATE OR REPLACE FUNCTION upsert_attr_snapshot_batch(snapshots jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  affected integer;
BEGIN
  INSERT INTO ml_item_attr_snapshot (item_id, attr_id, attr_value, snapshot_at)
  SELECT
    (s->>'item_id')::text,
    (s->>'attr_id')::text,
    (s->>'attr_value')::text,
    COALESCE((s->>'snapshot_at')::timestamptz, now())
  FROM jsonb_array_elements(snapshots) AS s
  ON CONFLICT (item_id, attr_id) DO UPDATE
    SET attr_value = EXCLUDED.attr_value,
        snapshot_at = EXCLUDED.snapshot_at;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_attr_snapshot_batch(jsonb) TO anon, authenticated, service_role;
