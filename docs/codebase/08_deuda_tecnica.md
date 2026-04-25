# Fase 8 — Riesgos y deuda técnica

> Ordenado por severidad. Las reglas de `inventory-policy.md` ya documentan varios de estos casos como antipatrones conocidos.

## 🔴 Crítico — riesgos de seguridad

### S1. PIN admin hardcodeado en código fuente
- `src/app/admin/page.tsx`: `const ADMIN_PIN = "1234";`
- `src/app/conciliacion/page.tsx`: `const ADMIN_PIN = "1234";`
- Validación 100% client-side. Cualquiera con la URL puede ver/eludir.
- **Convive** con un sistema más nuevo de `admin_users` (v61) que no es excluyente. La protección útil hoy se reduce a "no compartir la URL".

### S2. RLS efectivamente desactivado
- Casi todas las tablas tienen `CREATE POLICY ... USING (true) WITH CHECK (true)`.
- La anon key está expuesta al cliente. Cualquier persona con la anon key puede leer/escribir cualquier tabla — **incluyendo tokens OAuth ML guardados en `ml_config`**, costos, márgenes y movimientos bancarios.
- Documentado como limitación conocida en `.claude/rules/security.md`, pero sigue siendo el riesgo #1.

### S3. Webhook ML sin verificación de firma
- `src/app/api/ml/webhook/route.ts` acepta cualquier POST con shape válido. ML provee mecanismo de firma; el repo lo ignora.
- Cualquiera puede inyectar eventos falsos: marcar shipments como entregados, disparar resyncs, polución de `ml_webhook_log`.

### S4. RPC `exec_sql(sql)` ejecutable desde anon
- Existe en la DB y se invoca desde `/api/ml/audit-mappings`. Si la RPC acepta SQL arbitrario y la policy es permisiva, la anon key permite **ejecutar SQL arbitrario** en producción.
- TODO: revisar la firma exacta de la función en Supabase.

### S5. Service role key inconsistente
- Usado en `src/app/api/ml/setup-tables/route.ts:11` y `scripts/debug-shipping.mjs:15` con fallback a anon.
- En el resto del repo no se usa, contradiciendo la regla "no service role" de `supabase.md`.
- **Filtrarla por accidente** (logging en endpoint con error 500, `.env.local` commiteado por error) es catastrófico.

### S6. PINs de operarios en texto plano
- Tabla `operarios` con campo `pin: text`. Sin hash. Documentado en `.claude/rules/security.md`.

### S7. Credenciales SII guardadas en `sessionStorage`
- `src/app/conciliacion/page.tsx` guarda RUT + clave SII en `sessionStorage` (`SII_CREDS_KEY`). Vulnerable a XSS — cualquier extensión maliciosa o script inyectado las lee.

## 🟠 Alto — calidad y mantenibilidad

### Q1. Funciones gigantes
- `src/lib/intelligence.ts: recalcularTodo` — **1 491 líneas**. Es el motor de inteligencia completo en una función. Difícil de leer, testear y refactorizar.
- `src/lib/ml.ts: syncStockFull` — **517 líneas**. Loop principal del sync de stock Full.
- Ambas son los blast-radius más grandes del sistema: cualquier bug ahí afecta el inventario y la sincronización con ML.

### Q2. Megacomponentes
- `src/app/admin/page.tsx` — **12 201 líneas**. Contiene Dashboard, AdminRecepciones, AdminUltimaMilla, AdminEnviosFull, Operaciones, Inventario, Movimientos, Productos, AdminTimeline, Configuracion, MobileMenu como sub-componentes en el mismo archivo.
- `src/app/conciliacion/page.tsx` — 2 890 líneas.
- `src/components/AdminInteligencia.tsx` — 3 105 líneas.
- `src/components/AdminReposicion.tsx` — 2 914 líneas.
- `src/components/AdminComercial.tsx` — 2 514 líneas.

### Q3. Centinelas numéricos vigentes (Regla 1 de `inventory-policy.md`)
Casos detectados en `src/lib/intelligence.ts`:
- `:1165` — `cv = ... > 0 ? std/media : 999`.
- `:1225` — `dio = ... > 0 ? (st/vel)*7 : 999`.
- `:1418` — `cobFull < puntoReorden && cobFull < 999`.
- `:1440` — `diasSinConteo = ultimoConteo ? ... : 999`.
- `:2076` — `r.cob_full < r.punto_reorden && r.cob_full < 999`.
- `src/lib/intelligence-queries.ts:720` — `rawStock === -1 ? null : ...` (al menos este lo trata como `null`).

Todos son los "admisibles" descritos por la regla, pero la deuda persiste y se expande.

### Q4. Patrón `void sb.from(...)` (Regla 3 de `inventory-policy.md`)
Detectado en al menos 6 archivos:
- `src/app/api/ml/activate-warehouse-all/route.ts:104,115` — insert audit_log fire-and-forget.
- `src/app/api/ml/activate-warehouse/route.ts:97,114`.
- `src/app/api/ml/orders-history/route.ts:244` — update ml_shipments.
- `src/lib/ml.ts:847,1319,1334,1390,1399` — múltiples upserts/inserts.

Todos potencialmente silenciosos. Audit log es lo más sensible: si el insert falla, **se pierde la traza** de la acción que ya ocurrió.

### Q5. Patrón `.catch(() => {})` (Regla 3)
- `src/app/operador/picking/page.tsx`: 5 ocurrencias (líneas 43, 84, 155, 244, 379, 380).
- `src/app/operador/recepciones/page.tsx`: líneas 131, 140, 397.
- `src/app/admin/page.tsx:5595`.

### Q6. Modelo dual de pedidos Flex no migrado (Regla 5)
- `pedidos_flex` (legacy) coexiste con `ml_shipments + ml_shipment_items` (nuevo, shipment-centric).
- El código consulta ambos. Tarde o temprano divergen y resuelven conflicto.
- Sub-bug abierto en `inventory-policy.md` "Regla 5 → Bonus histórico".

### Q7. Modelo dual de proveedor (en transición controlada — v72)
- `proveedor: text` y `proveedor_id: uuid` conviven en 5 tablas (`recepciones`, `ordenes_compra`, `productos`, `proveedor_catalogo`, `rcv_compras`).
- Hay backfill (`/api/proveedores/backfill`) y resolve (`/api/proveedores/resolve`), pero apps externas (App Etiquetas) todavía no llaman al resolve.

### Q8. Columna zombi `ml_items_map.stock_full_cache`
- Marcada deprecada en v58 con `COMMENT ON COLUMN`, pero la columna física existe.
- Antecedente: causó stock fantasma al admin durante 14 SKUs / 22 días (ver Regla 5 de inventory-policy.md). Ya hay sync espejo, pero la mejor fix es DROP cuando el código deje de leerla.

### Q9. Modelo Anthropic desactualizado
- `claude-sonnet-4-20250514` hardcoded en `src/app/api/agents/chat/route.ts:69` (default si no hay config) y `src/app/api/agents/feedback/route.ts:63`.
- El más reciente es `claude-sonnet-4-6`. Migración en 5 minutos.

### Q10. Numeración de migraciones colisiona
- 18 pares de archivos con el mismo número (dos `v15`, dos `v17`, …, dos `v68`). Se distinguen por el sufijo descriptivo.
- No es destructivo (no hay schema_migrations table — son ejecuciones manuales) pero hace que `ls supabase-v*.sql | sort -V` no de un orden estable. Difícil saber el orden real.

## 🟡 Medio — operación y procesos

### O1. No hay `.env.example`
- `.gitignore` excluye `.env*`. No hay template de variables esperadas.
- Onboarding de nuevo dev requiere contactar al owner para conocer las variables (24 detectadas en Fase 2).

### O2. Migraciones se ejecutan a mano
- No hay CLI ni tooling de migrations. El "estado real" de la DB depende de que Vicente haya ejecutado el archivo SQL correcto.
- Riesgo de drift: que prod tenga columnas que dev no tiene (o viceversa).
- Carpeta `supabase/pending-mov/` sugiere una colita de pendientes manual.

### O3. Regla `testing.md` desactualizada
- Afirma "no hay infraestructura de testing", pero hay 11 tests Vitest activos. Actualizar para evitar que un agente IA nuevo escriba código sin correrlos.

### O4. Comments y docs internas inconsistentes
- 3 TODO/FIXME en todo `src/`. Casi cero comentarios obsoletos. Esto es bueno.
- En cambio, hay cadenas largas de "DESACTIVADO 2026-04-24:" en `admin/page.tsx:303` (SheetSync deshabilitado). Útil pero deberían convertirse en delete con commit explicativo después de 1-2 semanas (la regla la pone el comentario mismo).

### O5. Migraciones tipo "fix"/"drop"/"deprecar" indican retoques tardíos
- `supabase-v9-fix.sql`, `v13-fix-update-stock`, `v31-fix-reservas-cutoff`, `v32-fixes-operador`, `v58-deprecar-columna-zombi`, `v59-drop-flex-objetivo`, `v73-drop-productos-sku-venta`, `v74-drop-productos-codigo-ml`.
- Patrón normal en un sistema vivo, pero indica que el flujo de migrations no tiene revisiones previas (un v59 que dropea una columna agregada en v57).

### O6. 28 endpoints `/api/debug*`, `/api/ml/debug`, `/api/diagnostico-recepcion`, `/api/admin/debug-fix`, `/api/admin/debug-query`
- En producción accesibles sin auth. Útiles pero un atacante podría usarlos para reconnaissance o, peor (`debug-fix`, `debug-query`), para mutar estado.
- Mover detrás de un guard mínimo (aunque sea un secret) o eliminar.

### O7. PIN reset demo en sidebar
- `src/app/admin/page.tsx:342` botón "Reset Demo" llama `resetStore()` con un confirm. Un click accidental con PIN válido borra estado del cliente. Bajo impacto si `resetStore` es solo client-side; alto si toca DB. TODO: confirmar.

### O8. Drift entre reglas y código
- `.claude/rules/supabase.md` dice "no service role" — el código usa service role en 2 lugares.
- `.claude/rules/testing.md` dice "no tests" — hay 11.
- `.claude/rules/inventory-policy.md` Regla 3 prohíbe `void sb.from`, pero el patrón sigue presente.
- Cada drift es un tiempo de onboarding perdido para un agente nuevo.

## 🟢 Bajo — limpieza

### L1. Archivos en raíz que parecen históricos
- `plan.md` (8.8 KB, marzo). TODO: confirmar si vigente o moverlo a `docs/`.
- `template-catalogo-proveedores.xlsx` en raíz — más natural en `public/templates/` o `docs/manuales/`.
- `tsconfig.tsbuildinfo` (197 KB) — está en `.gitignore` (`*.tsbuildinfo`), pero igual aparece committed. Verificar.

### L2. Variables `playwright` listada como devDep pero sin specs ni config
- Si no se usa, removerla.

### L3. Numerosos `console.log` (28 archivos)
- En endpoints — log estructurado tipo Vercel logs ya cubre, pero quedan ruidos en consola del navegador. Limpieza menor.

## Inventario rápido de hallazgos

| # | Área | Severidad | Impacto |
|---|---|---|---|
| S1 | PIN hardcoded | Crítico | Cualquiera ve/editaadmin con la URL |
| S2 | RLS permisivo + anon key client | Crítico | Lectura/escritura libre de toda la DB |
| S3 | Webhook ML sin firma | Crítico | Inyección de eventos falsos |
| S4 | RPC `exec_sql` accesible | Crítico | SQL arbitrario en prod |
| S5 | Service role key fallback | Crítico | Si filtra, bypasses RLS |
| S6 | PIN operario plano | Alto | Acceso operador con DB leak |
| S7 | Creds SII en sessionStorage | Alto | XSS exfil |
| Q1 | Función 1491 líneas | Alto | Mantenibilidad motor |
| Q2 | Megacomponentes 12k LOC | Alto | Mantenibilidad UI |
| Q3 | Centinelas 999 | Alto | Decisiones sesgadas |
| Q4-Q5 | Errores silenciosos | Alto | Bugs invisibles |
| Q6-Q8 | Modelos duales | Alto | Drift, divergencia |
| Q9 | Sonnet 4 viejo | Medio | Migrar a 4.6 |
| Q10 | Migraciones colisionan | Medio | Confusión de orden |
| O1-O2 | Sin `.env.example`, sin tool de migrations | Medio | Onboarding |
| O3-O8 | Drift docs/código, debug expuesto | Medio | Riesgo creciente |

## Riesgos no cubiertos en este discovery (TODO)

1. Auditar el real RLS de la DB en producción (no solo lo que dicen las migraciones — alguien pudo haber subido policies más estrictas a mano).
2. Confirmar firma actual de `exec_sql` RPC.
3. Confirmar configuración del bucket `banva` (público vs privado, RLS de storage).
4. Tamaño real de tablas y crecimiento — query SQL recomendada en Fase 4.
5. Análisis de runtime: qué cron está fallando crónicamente (no se puede inferir desde el repo).
