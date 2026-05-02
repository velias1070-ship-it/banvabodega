# Atlas Runbook — BANVA Bodega

**Sprint 0.7 (2026-05-02).** Cómo opera Atlas en este repo y qué hacer cuando alerta.

---

## Qué es Atlas y por qué lo usamos

[Atlas](https://atlasgo.io/) ejecuta **drift detection** entre `supabase/migrations/` (versionado) y la DB de producción. Alerta si alguien tocó schema fuera del proceso de migrations versionadas (ejemplo: `exec_sql` directo, ALTER TABLE manual desde Supabase Studio, RPC con DDL embebido, etc.).

**Coexiste con Supabase CLI**: ambos leen el mismo folder. Supabase CLI deploya, Atlas valida. La fuente de verdad sigue siendo `supabase/migrations/` con formato canónico `YYYYMMDDHHMMSS_<snake_case>.sql` (CONVENTIONS.md §2).

**Decisión owner cerrada (2A):** Supabase CLI + Atlas en CI.

**Motivador:** prevenir el próximo episodio tipo `exec_sql` — drift silencioso entre prod y migrations.

---

## Cuándo se ejecuta

| Trigger | Qué corre | Bloqueante |
|---|---|---|
| **PR que toca `supabase/migrations/` o `atlas.hcl`** | `atlas migrate validate` (hash + SQL parse) + naming snake_case check (bash grep) + validación tag `[non-reversible:reason]` para destructivas | Sí (falla CI) |
| **Push a `main` que toca migrations** | Drift check repo ↔ prod | No bloquea (warning) |
| **Cron diario 11:30 UTC** (08:30 Chile) | Drift check programado, alerta a Slack si encuentra diff | No bloquea |
| **Manual `workflow_dispatch`** | Drift check on-demand | No bloquea |

---

## Qué hacer cuando Atlas detecta drift

### Caso 1 — Drift detectado en cron diario

1. Revisar artifact `drift-report.txt` del workflow run en GitHub Actions.
2. Identificar la diferencia: ¿qué tabla / columna / función está en prod pero no en `supabase/migrations/`? (O viceversa.)
3. **Investigar el origen**:
   - `git log --all --since='7 days ago' supabase/migrations/` — ¿hay alguna migration que haya quedado sin pushear?
   - Buscar en código `mcp__supabase__apply_migration` o `execute_sql` con DDL en agentes / scripts.
   - Revisar Supabase Studio → SQL Editor → ¿alguien corrió SQL directo?
   - Preguntar al equipo en Slack si alguien tocó schema manual.
4. **Resolver** según el hallazgo:
   - **El cambio en prod es legítimo y debe quedar** → crear migration que lo capture, commit con `[batch:YYYYMMDD-N]`, push. La próxima corrida del cron debería decir "Sin drift".
   - **El cambio en prod es accidental** → revertir manualmente (idealmente con migration que lo deshace), documentar incidente en `/docs/incidents/<fecha>-<resumen>.md`.
   - **Tabla/columna legítima fuera de migrations** (logs, audit) → agregar a `exclude` en `atlas.hcl`. Documentar por qué en este runbook (sección "Excepciones documentadas").

### Caso 2 — PR bloqueado por destructiva sin tag

Mensaje de error en CI:
```
::error::Migration destructiva sin tag [non-reversible:reason] en commit message del PR.
```

**Solución:**

1. Confirmar que la destructiva es realmente necesaria (no hay alternativa expand-contract: agregar la columna nueva, dual-write por una semana, leer de la nueva, dropear la vieja).
2. Si es necesaria, agregar al commit message del PR (puede ser un nuevo commit o `git commit --amend` si la rama no fue pusheada todavía):

```
feat(sprint-X): drop legacy column from productos

Texto explicando el cambio y por qué.

[batch:20260502-1]
[non-reversible:column-deprecated-since-vN-zero-reads-confirmed-via-grep]

Co-Authored-By: ...
```

El tag aceptado por el workflow es cualquiera con la forma `[non-reversible:<reason>]`. La razón es libre pero debe ser descriptiva (ej: `production-data-dropped`, `pk-changed-with-fk-cascade`, `column-zombi-since-2025-12`).

### Caso 3 — Lint falla por naming

El linter rechaza identificadores que no sean `snake_case` (regla CONVENTIONS.md §1).

**Solución:** renombrar la columna/tabla/constraint al patrón `^[a-z][a-z0-9_]*$` y re-commit.

---

## Comandos útiles localmente

Atlas requiere Docker disponible para `--dev-url docker://...` (DB efímera para validación).

```bash
# Ver migrations conocidas (lee atlas.sum)
atlas migrate hash --dir "file://supabase/migrations"

# Validar consistencia hash + parse SQL (Community Edition)
atlas migrate validate --dir "file://supabase/migrations"

# `atlas migrate lint` requiere Atlas Pro (cambió en v0.38). Si querés
# correr el linter completo localmente: `atlas login` y luego `atlas migrate lint
# --dev-url docker://postgres/15/dev --latest 5`. En CI usamos validate +
# naming check propio en bash.

# Comparar repo vs prod (necesita BANVA_PROD_DB_URL)
export BANVA_PROD_DB_URL="postgres://atlas_readonly:<pwd>@db.<project>.supabase.co:5432/postgres?sslmode=require"
atlas schema diff \
  --from "$BANVA_PROD_DB_URL" \
  --to "file://supabase/migrations?format=atlas" \
  --dev-url "docker://postgres/15/dev"

# Generar visualización del schema actual
atlas schema inspect --env prod --visualize > schema.html

# Ver últimas corridas del cron desde terminal (gh CLI)
gh run list --workflow=atlas-drift.yml --limit=10
gh run view <run-id> --log
```

> Si el binario `atlas` no está en `$PATH`, instalarlo:
> - macOS Homebrew: `brew install ariga/tap/atlas` (requiere CLT actualizadas).
> - Binario directo: `curl -sLo /usr/local/bin/atlas https://release.ariga.io/atlas/atlas-darwin-arm64-latest && chmod +x /usr/local/bin/atlas` (ARM Mac) o `atlas-linux-amd64-latest` para Linux.

---

## Excepciones documentadas

Tablas y prefijos excluidos del drift check (legítimas, gestionadas fuera de `supabase/migrations/`):

| Tabla / patrón | Motivo |
|---|---|
| `audit_log` | Append-only desde la app. Schema estable, no se modifica vía migrations. |
| `ml_webhook_log` | Append-only de webhooks ML. Idem. |
| `admin_actions_log` | Append-only de acciones de UI. Idem. |
| `agent_runs` | Log de runs del sistema multi-agente. Idem. |
| `agent_insights` | Insights persistidos por agentes. Idem. |
| `agent_snapshots` | Cache de datos por run. Idem. |
| `_sprint*_*` | Tablas temporales de auditoría por sprint. Borradas al cerrar el sprint (CONVENTIONS.md §1). |
| `_audit_*` | Tablas de auditoría temporal. |
| `_deprecated_*` | Tablas en cuarentena para DROP futuro. |

Si hay que agregar más exclusiones, editar `exclude` en `/atlas.hcl` y documentar acá.

---

## Triggers para reconsiderar Atlas

Si en 6 meses (ETA revisión: **2026-11**) cumple alguno:

- Drift falsos positivos > 1 por semana → ajustar `exclude` o desactivar el cron.
- Setup mantenimiento > 1 hora/mes → simplificar (ej: sólo lint en PR, sin drift contra prod).
- Migración a otro stack (Drizzle, Prisma) → re-evaluar herramienta.
- Atlas Cloud paid features ya no son gratis → quedarse en CLI local.
- Drift inexplicable (sin git log, sin Studio access, sin agente activo) → investigar acceso no autorizado a Supabase. Tratar como incidente de seguridad, no de proceso.

---

## Rollback rápido

| Síntoma | Acción |
|---|---|
| Workflow falla por bug en sí mismo | `mv .github/workflows/atlas-drift.yml .github/workflows/atlas-drift.yml.disabled` y push. |
| Drift falsos positivos de tablas legítimas | Editar `atlas.hcl` → `exclude` y push. |
| `atlas_readonly` bloquea queries que ya no son SELECT | Ajustar GRANTs (ver `/docs/atlas-runbook.md` setup) o rotar credentials. |
| Reversión total | DROP ROLE `atlas_readonly`; eliminar workflow file; eliminar `atlas.hcl`. Migrations siguen sin afectarse. |

---

## Setup inicial (para humanos con admin)

### 1. Crear usuario `atlas_readonly` en Supabase

```sql
CREATE ROLE atlas_readonly WITH LOGIN PASSWORD '<random-strong>';
GRANT USAGE ON SCHEMA public TO atlas_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO atlas_readonly;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO atlas_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO atlas_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO atlas_readonly;
GRANT pg_read_all_stats TO atlas_readonly;
-- pg_catalog y information_schema están accesibles por default
```

### 2. Configurar GitHub Secrets

Repo Settings → Secrets and variables → Actions → New repository secret:

- `BANVA_PROD_DB_URL` — connection string de Supabase con el usuario `atlas_readonly`. Formato: `postgres://atlas_readonly:<pwd>@db.<project>.supabase.co:5432/postgres?sslmode=require`.
- `SLACK_WEBHOOK_DRIFT` (opcional) — webhook de Slack a un canal de alertas. Si no se configura, el cron sólo notifica vía estado de workflow run.
- `ATLAS_TOKEN` (opcional) — sólo si en algún momento se usa Atlas Cloud.

### 3. Verificar que Docker está disponible en runners

`ariga/setup-atlas@v0` y `--dev-url docker://...` requieren Docker en el runner. Los runners default `ubuntu-latest` lo tienen pre-instalado.

---

## Referencias

- `/CONVENTIONS.md` §2 — formato de migrations canónico.
- `/atlas.hcl` — configuración Atlas del repo.
- `/.github/workflows/atlas-drift.yml` — el workflow que ejecuta esto.
- `/docs/policies/inventario.md` y `/docs/policies/inventario-formulas.md` — policies vinculantes (no hacer changes destructivos contra estas tablas sin coordinación).
- Atlas docs: https://atlasgo.io/
