# WMS Diccionario Update — Instrucciones

## Paso 1: SQL Migration (Supabase)
1. Ve a Supabase → SQL Editor → New query
2. Pega el contenido de `supabase-migration-diccionario.sql`
3. Click "Run"
4. Esto crea:
   - Columnas nuevas `tamano` y `color` en tabla `productos`
   - Tabla `composicion_venta` (mapeo SKU Venta → componentes físicos)
   - Vista `vista_venta` para consultas rápidas

## Paso 2: Actualizar archivos del repo
Reemplaza estos archivos en tu repo `banvabodega`:

| Archivo en el zip | Destino en el repo |
|---|---|
| `db.ts` | `src/lib/db.ts` |
| `store.ts` | `src/lib/store.ts` |
| `SheetSync.tsx` | `src/components/SheetSync.tsx` |
| `admin-page.tsx` | `src/app/admin/page.tsx` |

## Paso 3: Push y deploy
```bash
git add -A
git commit -m "Diccionario de ventas con packs/combos"
git push
```
Vercel auto-deploya.

## Paso 4: Verificar
1. Abre admin → espera sync automático o click "Sincronizar"
2. Debería mostrar: "X productos físicos · Y combos/packs"
3. Ve a tab Productos → verifica que aparecen con proveedor, categoría, tamaño, color

## Estructura de datos

### Tabla `productos` (producto físico en bodega)
- `sku` = SKU Origen (clave primaria)
- `nombre` = Nombre Origen
- `proveedor`, `categoria`, `tamano`, `color` del producto físico

### Tabla `composicion_venta` (packs/combos ML)
- `sku_venta` = lo que se publica en MercadoLibre
- `codigo_ml` = código de la publicación ML
- `sku_origen` = producto físico que lo compone
- `unidades` = cuántas unidades de ese sku_origen van en el pack

### Ejemplo: Pack de 2 almohadas viscoelásticas
```
sku_venta: ALM-VISCO-PK2    codigo_ml: MLC123    sku_origen: ALM-VISCO    unidades: 2
```

### Ejemplo: Pack sábana + almohada
```
sku_venta: COMBO-SAB-ALM    codigo_ml: MLC456    sku_origen: SAB-180    unidades: 1
sku_venta: COMBO-SAB-ALM    codigo_ml: MLC456    sku_origen: ALM-STD    unidades: 1
```
