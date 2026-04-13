# Backups de la base de datos

Backups automáticos de la DB de Supabase de producción (proyecto `qaircihuiafgnnrwcjls`) hechos por GitHub Actions con `pg_dump -F c`. Se suben al bucket privado `db-backups` de Supabase Storage, organizados por carpeta según frecuencia. El workflow vive en [`.github/workflows/db-backup.yml`](../.github/workflows/db-backup.yml).

## Frecuencias y retención

| Tipo    | Cuándo corre (Chile UTC-3)         | Carpeta en bucket | Nombre del archivo                       | Retención |
|---------|------------------------------------|-------------------|------------------------------------------|-----------|
| 6h      | 04:00 / 10:00 / 16:00 / 22:00      | `6h/`             | `banva-prod-YYYY-MM-DD-HHMM.dump`        | 7 días    |
| daily   | 04:00 (promovido del slot de 6h)   | `daily/`          | `banva-prod-YYYY-MM-DD.dump`             | 30 días   |
| weekly  | Domingo 04:00 (promovido)          | `weekly/`         | `banva-prod-YYYY-MM-DD.dump`             | 90 días   |
| monthly | Día 1 del mes 04:00 (promovido)    | `monthly/`        | `banva-prod-YYYY-MM.dump`                | 365 días  |

Solo hay **un** schedule cron real (`0 1,7,13,19 * * *` UTC). Daily/weekly/monthly se derivan dentro del job leyendo `date -u +%H/%u/%d`: el slot de las 04:00 Chile hace `pg_dump` una sola vez y promueve el mismo archivo a las carpetas correspondientes vía re-upload (no hay copy server-side, no hay race conditions, las fallas son independientes por target).

El prune corre al final del mismo job: lista cada carpeta con `POST /storage/v1/object/list/db-backups` y borra lo que esté fuera de su ventana de retención. Cada loop solo toca su propia carpeta y usa un regex específico — no puede borrar de una carpeta ajena.

## Disparar un backup manual

Requiere `gh` CLI con scope `workflow`.

```bash
# Solo el slot 6h (default)
gh workflow run db-backup.yml -f backup_type=6h

# Solo daily (sube a daily/, no toca 6h/)
gh workflow run db-backup.yml -f backup_type=daily

# Solo weekly o solo monthly
gh workflow run db-backup.yml -f backup_type=weekly
gh workflow run db-backup.yml -f backup_type=monthly

# Sube a las 4 carpetas de un solo viaje (útil para validar todo el flujo)
gh workflow run db-backup.yml -f backup_type=all
```

Después del trigger:

```bash
gh run list --workflow=db-backup.yml --limit 5   # ver runs recientes
gh run watch                                     # stream del run en curso
gh run view --log                                # logs completos del último run
gh run view --log-failed                         # solo los steps que fallaron
```

Alternativa UI: GitHub → Actions → "Daily DB Backup" → **Run workflow** → elegir tipo → **Run**.

## Secrets de GitHub

Los 3 secrets están en `Settings → Secrets and variables → Actions` del repo:

| Secret                       | Qué es                                                  | Dónde sacarlo                                                                 |
|------------------------------|---------------------------------------------------------|-------------------------------------------------------------------------------|
| `SUPABASE_DB_URL`            | Connection string al **Session Pooler** (puerto 5432)   | Supabase → Project Settings → Database → Connection string → **Session pooler** |
| `SUPABASE_PROJECT_REF`       | `qaircihuiafgnnrwcjls`                                  | Es el ref del proyecto (parte del subdominio Supabase)                        |
| `SUPABASE_SERVICE_ROLE_KEY`  | JWT del role `service_role`                             | Supabase → Project Settings → API → Project API keys → `service_role`         |

> **No usar Direct Connection (`db.<ref>.supabase.co`)** desde GitHub Actions: Supabase deshabilitó IPv4 directo, los runners de GitHub son IPv4-only, da timeout. **Tampoco usar Transaction Pooler (puerto 6543)**: `pg_dump` necesita sesión persistente.
>
> En el pooler el username **NO** es `postgres` sino `postgres.qaircihuiafgnnrwcjls`. Si la pass tiene caracteres especiales (`@ : / # ? & %`), URL-encodearlos en la connection string.

## Escenarios de falla y cómo recuperarse

### 1. Reset de password de la DB

**Síntoma**: workflow falla en step "Create dump" con `FATAL: password authentication failed for user "postgres.qaircihuiafgnnrwcjls"`.

**Causa**: alguien resetéo la password de la DB en Supabase y el secret quedó stale.

**Fix**:
1. Supabase → Project Settings → Database → "Reset database password" (o copiar la actual si la tenés).
2. Construir la URI nueva: `postgresql://postgres.qaircihuiafgnnrwcjls:<NEW_PASSWORD_URL_ENCODED>@aws-1-us-east-1.pooler.supabase.com:5432/postgres` (el host puede variar — copiar el del dashboard).
3. GitHub → Settings → Secrets → `SUPABASE_DB_URL` → Update → pegar URI nueva.
4. `gh workflow run db-backup.yml -f backup_type=6h` para validar.

### 2. Upgrade de Postgres en Supabase

**Síntoma**: workflow falla con `pg_dump: error: aborting because of server version mismatch — server version: 18.x; pg_dump version: 17.x`.

**Causa**: Supabase upgradeó el cluster (ej. 17 → 18) y el cliente que instalamos quedó atrás.

**Fix** en `.github/workflows/db-backup.yml`, hay 3 lugares con la versión hardcodeada — buscar `17` y reemplazar por la nueva (ej. `18`):
1. `sudo apt-get install -y postgresql-client-17` → `postgresql-client-18`
2. `/usr/lib/postgresql/17/bin/pg_dump --version` (step Install)
3. `/usr/lib/postgresql/17/bin/pg_dump -F c ...` (step Create dump)

Commit + push a `main`. Disparar `gh workflow run db-backup.yml -f backup_type=6h` y verificar que el step Install imprima `pg_dump (PostgreSQL) 18.x`.

> El binario absoluto evita que el `pg_wrapper` de `postgresql-common` siga apuntando a la versión preinstalada en ubuntu-latest. **No quitar la ruta absoluta**.

### 3. Rotación del service_role key

**Síntoma**: step "Upload to targets" o "Prune all prefixes" falla con HTTP 401/403.

**Causa**: alguien rotó/regeneró el service_role key (porque se filtró, por política de seguridad, etc).

**Fix**:
1. Supabase → Project Settings → API → Project API keys → `service_role` → "Reveal" → copiar el JWT nuevo.
2. GitHub → Settings → Secrets → `SUPABASE_SERVICE_ROLE_KEY` → Update.
3. Disparar workflow manual para validar.

> El service_role key bypasea RLS y tiene poder total sobre el proyecto. **Nunca** committearlo, ni ponerlo en frontend, ni pegarlo en logs/Slack/issues.

### 4. Borrado del bucket `db-backups`

**Síntoma**: todos los uploads fallan con HTTP 404 `Bucket not found`. El prune también falla porque `list` retorna 404.

**Causa**: alguien eliminó el bucket desde el dashboard.

**Fix**:
1. Supabase → Storage → New bucket → name `db-backups` → **Private** (NO público — contiene la DB completa) → Create.
2. `gh workflow run db-backup.yml -f backup_type=all` para repoblar las 4 carpetas con un dump nuevo.
3. **Los backups históricos están perdidos** salvo que existan en otro lado (snapshots de Supabase del plan pago, exports manuales). Si nunca configuraste un destino offsite, este es el incidente que duele.

### 5. La DB crece y el dump no entra en el runner

**Síntoma(s)** por orden de aparición a medida que crece:
- Step "Create dump" falla con `No space left on device` (runners ubuntu-latest tienen ~14 GB libres)
- Job se mata por timeout (límite de 6 h en planes free/pro de GitHub Actions)
- Upload tarda mucho y falla por timeout de la API de Storage

**Mitigaciones por orden de menor a mayor cambio**:

1. **Excluir tablas grandes que no necesitan backup** — agregar flags al `pg_dump`:
   ```
   --exclude-table-data=public.movimientos_log
   --exclude-table-data=public.stock_full_cache
   ```
   Útil para tablas de logs/cache regenerables. **Ojo**: `--exclude-table-data` mantiene el schema, `--exclude-table` borra schema y datos. Decidir caso por caso.

2. **Subir un schema-only por separado** (`pg_dump -s ...`) para tener al menos la estructura aunque los datos no entren.

3. **Limpiar tablas hot antes del dump** — purgar registros viejos de tablas grandes con un cron app-side, no del workflow de backup.

4. **Mover el almacenamiento a un bucket externo** (S3 / R2) si Supabase Storage también empieza a fallar por tamaño. El upload se hace con `aws s3 cp` o equivalente; el resto del workflow no cambia.

5. **Pasar a un runner self-hosted o más grande** (`runs-on: ubuntu-latest-16gb` en GitHub-hosted larger runners, o un runner propio en una VM con disco). Implica costos.

6. **Habilitar Point-In-Time Recovery (PITR) de Supabase** si vas a un plan pago — reemplaza este workflow como backup primario, lo dejás como secundario.

## Cómo restaurar un dump

> ⚠️ **Nunca restaurar directo a la DB de producción.** Restaurar primero a un proyecto Supabase nuevo o a un Postgres local, validar que los datos se vean bien, y solo después tomar la decisión de promoverlo.

### 1. Bajar el dump

Desde Supabase Dashboard → Storage → bucket `db-backups` → carpeta correspondiente (ej. `daily/`) → click en el archivo → **Download**.

O por CLI con curl + service_role:
```bash
curl -L -o banva-prod-2026-04-12.dump \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  "https://qaircihuiafgnnrwcjls.supabase.co/storage/v1/object/db-backups/daily/banva-prod-2026-04-12.dump"
```

### 2. Inspeccionar antes de restaurar (no escribe nada)

```bash
pg_restore -l banva-prod-2026-04-12.dump | head -50
```

Lista los objetos del dump (schemas, tablas, índices, funciones). Si imprime una lista legible → el archivo está sano.

### 3. Restaurar a un target

Restauración completa a un Postgres limpio:
```bash
pg_restore -F c \
  --no-owner --no-acl \
  --clean --if-exists \
  -d "$TARGET_DB_URL" \
  banva-prod-2026-04-12.dump
```

Flags:
- `-F c` — el dump fue creado con `-F c` (custom format).
- `--no-owner --no-acl` — ignora ownership y permisos del dump original; importante cuando restaurás a un proyecto distinto donde los roles no existen igual.
- `--clean --if-exists` — droppea los objetos antes de recrearlos, evita conflictos en una DB que ya tiene datos parciales.
- `-d` — connection string del target.

> El cliente `pg_restore` debe matchear (o ser más nuevo) que la versión del servidor que generó el dump. Si el dump es de Postgres 17 y tu cliente local es 16, va a fallar.

### 4. Restauración parcial (solo algunas tablas)

```bash
pg_restore -F c -d "$TARGET_DB_URL" \
  --no-owner --no-acl \
  -t productos -t stock \
  banva-prod-2026-04-12.dump
```

`-t` se puede repetir. Útil para recuperar una tabla específica que se corrompió, sin tocar el resto.

### 5. Validación post-restauración

```sql
-- Conteo rápido de filas en tablas críticas
SELECT 'productos' AS t, COUNT(*) FROM productos
UNION ALL SELECT 'stock', COUNT(*) FROM stock
UNION ALL SELECT 'movimientos', COUNT(*) FROM movimientos
UNION ALL SELECT 'pedidos_flex', COUNT(*) FROM pedidos_flex;
```

Comparar contra el último estado conocido bueno antes del incidente.
