# Policy — Inventario

> **Reglas vinculantes** de inventario en BANVA. Lo que el código DEBE cumplir.
> Si el código contradice una regla declarada acá, se corrige el código.
>
> Para fundamento, benchmarks externos o ideas exploratorias ver
> `/docs/manuales/inventarios/` (biblioteca de referencia, no autoritativa).

## P-INV-1 — Prioridad Full > Flex en partición de bodega

**Regla.** El cálculo `mandar_full` reserva primero lo necesario para cubrir el
déficit de Full. La bodega solo conserva el piso `buffer_ml` (anti-race con la
publicación ML). Todo lo demás está disponible para enviarse a Full si hay
déficit.

**Implementación canónica.** `src/lib/flex-full.ts` función
`calcularEstadoFlexFull`, versión v7 (2026-05-01).

```
disponibleParaFull = max(0, stock_bodega − buffer_ml)
deficit_full       = max(0, targetFullUds − stock_full)
mandar_full        = min(deficit_full, disponibleParaFull)
para_flex          = stock_bodega − mandar_full
```

**Prohibido.** Reservar `targetFlexUds` antes de calcular `mandar_full`. Esa
era la lógica v3-v6 y bloqueaba envíos a Full cuando la reserva Flex superaba
la bodega disponible — caso testigo TXTPBL20200SK 2026-05-01: stock_full=1
(cobertura 0.43 días), bodega=41, reservaFlex=42 (vel inflada por evento
×1.3 × pct_flex × 6 semanas), `mandar_full=0`. Inaceptable.

**Fundamento.** `BANVA_Manual_Inventarios_Parte1.md:577-578`:

> Cycle stock debe estar en Full para cumplir promesa de tiempo MELI.
> Safety stock puede estar parcialmente en bodega central, repuesto a Full vía
> replenishment frecuente.

Full es el canal premium MELI: ranking boost, insignia (+15% CTR), elegibilidad
a campañas. El cycle stock pertenece ahí; la bodega es para safety stock y
reposición.

**Excepción.** Si `vel_ponderada=0` y SKU sin historia, vale el fallback de
"lote inicial" en `intelligence.ts` (preservado): manda 1 bulto al Full igual.

## P-INV-2 — buffer_ml como único piso anti-race

**Regla.** El único valor que la bodega debe reservar antes de calcular envíos
a Full es `buffer_ml` (2 si no compartido, 4 si `sku_origen` aparece en
múltiples publicaciones ML).

**Razón.** El buffer evita race conditions con la publicación Flex en ML
(stock fantasma cuando ML aún no propaga la baja). No tiene relación con la
demanda esperada Flex; es un colchón de sincronización.

## P-INV-3 — stock_en_transito no entra en deficit_full

**Regla.** El cálculo de `deficit_full = targetFullUds − stock_full` ignora
`stock_en_transito`. Solo se considera lo que está físicamente en bodega.

**Razón.** Promesas de OC pueden demorar o llegar parciales. Si Full se está
vaciando *ahora*, mandar lo que hay en bodega *ahora*, sin esperar la próxima
recepción. `stock_en_transito` solo se usa en `pedir_proveedor` (evita
sobrepedir).

## P-INV-4 — Cambios de stock siempre vía RPC `registrar_movimiento_stock`

**Regla.** Todo cambio de stock genera un movimiento en la tabla `movimientos`.
Prohibido `updateStock` silencioso o updates directos a la tabla `stock` desde
aplicación.

**Razón.** Trazabilidad y auditoría. Memoria `feedback_movimientos_stock`.
Confirmado por casos donde updates directos dejaron divergencia bodega vs
movimientos.

---

## Pendiente — promover desde manuales con el owner

- Política `target_dias_full` por ABC (hoy: A=42, B=28, C=14, hardcoded en
  `intelligence.ts`).
- Política `pct_full` (hoy: 0.8 default, 0.7 si `margen_flex / margen_full > 1.1`,
  hardcoded en `intelligence.ts:175`).
- Política de safety stock por cuadrante ABC×XYZ (hoy: King Method en
  `intelligence.ts`, sin policy escrita).
- Política de liquidación (hoy: bandas DIO 30/60/90 con descuentos 10/25/40 en
  intelligence; cascada distinta 90/120/180 con -20/-40/-60 en pricing —
  conflicto documentado en auditoría 2026-04-28).
