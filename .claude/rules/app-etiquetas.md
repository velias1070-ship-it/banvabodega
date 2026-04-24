# App Etiquetas (banva1) — Repo hermano

## Ubicación

**Path:** `/Users/vicenteelias/banva1/` (sibling de `~/banvabodega/`)
**Remote:** `https://github.com/velias1070-ship-it/banva1.git`
**Deploy:** Vercel (app aparte, dominio separado)
**Stack:** HTML estático (index.html ~130KB) + Supabase client JS con anon key. Sin backend propio. OCR con Gemini.

## Rol en el sistema

Factura física → foto → OCR con Gemini → imprime etiquetas con códigos de barras → inserta recepciones en el Supabase **compartido** con banvabodega.

Es la **única fuente de recepciones en producción** (desde 2026-03-05). Todas las recepciones actuales tienen `created_by='App Etiquetas'`.

## Contrato con banvabodega

App Etiquetas escribe directo a 3 cosas en Supabase (no pasa por API REST de banvabodega):

1. **Storage bucket `banva`** — foto de la factura en `facturas/{folio}_{ts}.jpg`, upsert=true.
2. **INSERT en `recepciones`** — folio, proveedor, imagen_url, estado='CREADA', costo_neto/iva/bruto, notas='', created_by='App Etiquetas'.
3. **INSERT en `recepcion_lineas`** (una por SKU) — recepcion_id, sku UPPERCASE, codigo_ml, nombre, qty_factura, qty_recibida=0, qty_etiquetada=0, qty_ubicada=0, estado='PENDIENTE', requiere_etiqueta, etiqueta_impresa, tiene_variantes, sku_venta, costo_unitario, operario_*=''.

Banvabodega toma el hand-off desde ahí: conteo → etiquetado → ubicación → cierre (vía /operador/recepciones y RPC `registrar_movimiento_stock`).

## Cómo coordinar cambios cross-repo

Cuando una modificación en banvabodega requiere cambio correspondiente en App Etiquetas, el agente debe tocar AMBOS repos en la misma sesión.

**Rutas absolutas:**
```bash
# banvabodega
/Users/vicenteelias/banvabodega/

# App Etiquetas
/Users/vicenteelias/banva1/
```

**Workflow típico:**
1. Hacer cambio en banvabodega (ej. nuevo endpoint, cambio de schema).
2. `cd /Users/vicenteelias/banva1 && git pull` para traer últimos cambios.
3. Editar `banva1/index.html` (o el archivo que corresponda) para consumir el nuevo contrato.
4. Commit + push en banva1 (es su propio repo).
5. Commit + push en banvabodega.
6. Los deploys son independientes (cada repo tiene su propio proyecto en Vercel).

**Importante:** son dos repos separados con histórico independiente. Los commits NO cruzan entre ellos. No usar git submodule — sibling clone es más simple.

## Cambios pendientes conocidos (al 2026-04-23)

### Adoptar endpoint `/api/proveedores/resolve` de banvabodega

Hoy App Etiquetas inserta `recepciones.proveedor = dte.razon_social` (ej. "IDETEX S.A.") sin poblar `proveedor_id`. Cada recepción queda desalineada del canónico de banvabodega ("Idetex") hasta que un backfill la normaliza.

**Cambio requerido:** antes del INSERT, llamar:

```js
POST https://banvabodega.vercel.app/api/proveedores/resolve
Body: { rut, razon_social }
Response: { id, nombre_canonico, created }
```

Y escribir AMBOS en el INSERT: `proveedor: nombre_canonico` + `proveedor_id: id`.

Con fallback defensivo: si el endpoint falla o timeout (5s), seguir con `proveedor: dte.razon_social` y `proveedor_id: null`. El backfill de banvabodega cierra el gap.

Ver plan completo en `banvabodega/.claude/rules/supabase.md` sección "Proveedor: esquema canónico (v72+)".

### Opcional: dejar de escribir direct a Supabase

A mediano plazo, App Etiquetas debería consumir endpoints REST de banvabodega en vez de escribir direct (validación server-side + contrato explícito). Hoy el acoplamiento es vía schema de Supabase, lo cual es frágil.

## Regla para agentes en banvabodega

Si el agente detecta que un cambio en banvabodega (schema, RPC, endpoint) afecta a App Etiquetas:

1. Dejar explícito en el commit message: `(afecta banva1)`.
2. Si es urgente, modificar banva1 en la misma sesión.
3. Si no es urgente, documentar el cambio pendiente en este archivo bajo "Cambios pendientes conocidos".

No dejar drift silencioso. App Etiquetas es producción crítica.
