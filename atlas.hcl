// atlas.hcl — Atlas configuration for BANVA Bodega
//
// Sprint 0.7 (2026-05-02). Atlas coexiste con Supabase CLI: ambos leen
// el mismo folder `supabase/migrations/`. Supabase CLI deploya, Atlas
// valida (lint + drift detection).
//
// Decisión owner cerrada (2A): Supabase CLI + Atlas en CI.
//
// El motivador específico es prevenir el próximo episodio tipo `exec_sql`:
// drift entre schema en producción y migrations versionadas.
//
// Comandos canónicos:
//   atlas migrate status --env prod
//   atlas migrate lint --env prod --latest 5
//   atlas schema diff --env prod
//
// Ver runbook completo en /docs/atlas-runbook.md.
//
// 2026-05-02: workflow naming check rewrite (path filter trigger).

env "prod" {
  // URL de la DB live de Supabase (banvabodega project: qaircihuiafgnnrwcjls).
  // Lee de variable de entorno BANVA_PROD_DB_URL para no commitear secrets.
  // Usuario recomendado: atlas_readonly (SELECT-only).
  url = getenv("BANVA_PROD_DB_URL")

  // Dev URL — DB efímera que Atlas levanta para validación de migrations
  // antes de chequear contra prod. Postgres 15 = mismo major que Supabase.
  dev = "docker://postgres/15/dev?search_path=public"

  migration {
    // Coexistencia con Supabase CLI: mismo folder, mismo orden lexicográfico.
    dir = "file://supabase/migrations"

    // Hash a partir de Sprint 0 (formato YYYYMMDDHHMMSS_*.sql).
    // Las migrations legacy `supabase-vNN-*.sql` en raíz no se incluyen
    // (no están en supabase/migrations/), pero el schema vivo en prod
    // ya las refleja, así que el drift check siempre arranca desde el
    // estado actual.
    format = atlas

    // Tabla donde Atlas registra qué migrations ya aplicó. Mismo schema
    // que la app. Si Supabase CLI tiene su propia tabla, ambas conviven.
    revisions_schema = "public"
  }

  // Schemas a auditar en drift detection.
  schemas = ["public"]

  // Tablas legítimamente fuera de migrations (logs append-only, tablas
  // temporales de inspección de sprints, etc.). Si aparece drift en
  // alguna de estas, Atlas la ignora.
  exclude = [
    "public.audit_log",
    "public.ml_webhook_log",
    "public.admin_actions_log",
    "public.agent_runs",
    "public.agent_insights",
    "public.agent_snapshots",
    "public._sprint0_*",
    "public._audit_*",
    "public._deprecated_*"
  ]

  // Reglas de linting que se aplican en `atlas migrate lint`.
  lint {
    // Operaciones destructivas requieren tag explícito en commit message.
    // El workflow GitHub Actions valida la presencia del tag aparte.
    destructive {
      error = true
    }

    // Identificadores nuevos en snake_case (CONVENTIONS.md §1).
    naming {
      match   = "^[a-z][a-z0-9_]*$"
      message = "snake_case obligatorio (CONVENTIONS.md §1 columnas/tablas)"
    }
  }
}
