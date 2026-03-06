# Seguridad — Autenticación y Roles

## Modelo de autenticación

**No se usa Supabase Auth ni JWT.** La autenticación es minimalista y client-side:

### Admin
- PIN hardcodeado en `src/app/admin/page.tsx`: `const ADMIN_PIN = "1234"`
- Se valida client-side, se guarda en `sessionStorage` con key `banva_admin_auth`
- `useAuth()` hook custom: verifica sessionStorage al montar, expone `login(pin)` y `logout()`
- `LoginGate` component muestra form de PIN antes de renderizar admin
- Cerrar sesión = `sessionStorage.removeItem("banva_admin_auth")`

### Operador
- Tabla `operarios` en Supabase con campos `id`, `nombre`, `pin`, `activo`, `rol`
- Login por ID + PIN: `loginOperario(id, pin)` busca en DB con `.eq("id", id).eq("pin", pin).eq("activo", true)`
- PINs en texto plano en la DB (no hasheados)
- El operador se identifica por nombre en cada acción (conteo, picking, recepción)

### Rutas
- **Sin protección server-side.** No hay middleware de auth
- `/operador` — Acceso libre, el operador se identifica al hacer acciones
- `/admin` — Protección client-side con PIN
- `/api/ml/*` — Sin auth, accesibles públicamente
- `/` — Página pública con selector de rol

## Roles

Solo dos roles en tabla `operarios`:
- `operario` — Acceso a vistas de operador
- `admin` — Puede hacer todo (distinguido solo por el PIN del panel admin)

No hay middleware ni guards server-side que diferencien roles.

## Supabase RLS

**Todas las políticas son permisivas** — `USING (true)` para SELECT/UPDATE/DELETE, `WITH CHECK (true)` para INSERT. La seguridad depende de:
1. La anon key se expone solo en el frontend
2. No hay datos sensibles personales (es un sistema interno de bodega)

## Credenciales ML

- Client ID, Client Secret, tokens OAuth almacenados en tabla `ml_config`
- Accesibles desde client-side (la tabla tiene RLS permisivo)
- Las API routes en `/api/ml/` leen tokens directamente de la DB

## Concurrencia

- Bloqueo de líneas de recepción con `bloqueado_por` + `bloqueado_hasta` (15 min TTL)
- RPC atómico `bloquear_linea` con `SELECT ... FOR UPDATE` para evitar race conditions
- Fallback a comportamiento sin lock si la RPC v6 no está desplegada

## Limitaciones conocidas

- PIN admin hardcodeado en código fuente
- PINs de operarios en texto plano
- No hay rate limiting en API routes
- No hay validación de webhook secret de ML (campo existe pero no se verifica)
- Credenciales ML visibles desde el frontend via RLS permisivo
