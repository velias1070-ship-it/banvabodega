# Hallazgos — Pre-auditoría 2026-04-18

Investigación de 3 puntos del snapshot (`banva-bodega-snapshot-2026-04-18.md`). Sin código. Queries sobre DB al **2026-04-18 ~19:00 UTC** (último recálculo motor: 15:04 UTC).

## Hallazgo 1 — `dias_en_quiebre` ≥ 1 500 días

### 1.1 Distribución

| Tramo | n |
|---|---:|
| NULL | 1 |
| 0 | 475 |
| 1-30 | 2 |
| 31-100 | 6 |
| 101-365 | 0 |
| 366-1 000 | 9 |
| 1 001-1 500 | 2 |
| **> 1 500** | **38** |
| Máximo | **2 071 días** (5.67 años) |

Sólo **2-3 días de historia en `stock_snapshots`** (2026-04-16 a 2026-04-18, 130 filas con `en_quiebre_full=true`). Ninguna fecha ancestral justifica 2 071 días.

### 1.2 Causa — encontrada en el código

El motor **incrementa `dias_en_quiebre` por cada recálculo**, no por día calendario:

```ts
// src/lib/intelligence.ts:1105
if (enQuiebreAhora) {
  const prevDias = prev?.dias_en_quiebre;
  if (prev && (prevDias === null || (prevDias ?? 0) > 0)) {
    diasEnQuiebre = prevDias === null ? null : (prevDias ?? 0) + 1;  // ← BUG
    ...
  } else {
    // Acaba de entrar en quiebre: inicializar desde primer snapshot
    if (primerQuiebre) {
      diasEnQuiebre = diasQuiebre > 0 ? diasQuiebre : 1;
    } else {
      diasEnQuiebre = null;
    }
  }
}
```

El motor se ejecuta múltiples veces al día (cron 11 UTC + botón Recalcular + curls de debug + cron de lead-times lunes). Cada corrida suma **+1**. Con un promedio de ~80 recálculos/día × ~25 días = ~2 000. **Cuadra exactamente con el máximo observado (2 071).**

**Fix esperado**: calcular la diferencia real en días calendario entre `prev.updated_at` y `now()`, no un incremento ciego `+1`. Alternativa robusta: derivar siempre desde `primerQuiebre` (min fecha en `stock_snapshots` con `en_quiebre_full=true`) sin guardar contador persistido.

### 1.3 Los 38 SKUs afectados (top 15 por dias_en_quiebre)

| SKU | Nombre | Acción | días_q | primera_venta | factor_rampup | pedir | pedir_sin_rampup |
|---|---|---|---:|---|---:|---:|---:|
| TXV25QLBRVD30 | Quilt Breda 30P Verde | MANDAR_FULL | **2 071** | 2026-03-24 | 0.00 | 0 | 0 |
| TXV23QLAT15AQ | Quilt Atenas 15P Aqua | EXCESO | 2 068 | 2026-01-05 | 0.50 | 1 | 1 |
| JSAFAB440P15W | Sábanas AF Florelia 1.5 | AGOTADO_PEDIR | 2 067 | 2026-04-08 | **0.00** | **0** | **1** |
| ALPCMPRDG4575 | Limpiapies Coco 45x75 Dog | AGOTADO_PEDIR | 2 066 | 2026-02-10 | **0.00** | **0** | **5** |
| TXPMMF15PGLXY | Plumón Galaxy | AGOTADO_SIN_PROV | 2 065 | 2026-01-03 | 0.50 | 1 | 1 |
| TXTPBL1822005 | Topper Illusions King | AGOTADO_SIN_PROV | 2 065 | 2026-01-06 | 0.50 | 1 | 1 |
| TXV23QLAT15BE | Quilt Atenas 15P Beige | AGOTADO_SIN_PROV | 1 931 | 2026-01-02 | 0.50 | 4 | 8 |
| TXV23QLAT15NG | Quilt Atenas 15P Negro | AGOTADO_SIN_PROV | 1 930 | 2026-01-02 | 0.50 | 16 | **32** |
| TEXCCWTILL10P | Cubrecolchón Illusions WP 10P | AGOTADO_SIN_PROV | 1 908 | 2026-02-04 | 0.50 | 81 | **162** |
| TXV23QLRM30GR | Quilt Roma 30P Gris | AGOTADO_SIN_PROV | 1 916 | 2026-01-03 | 0.50 | 22 | 43 |
| TXV23QLAT20NG | Quilt Atenas 20P Negro | AGOTADO_SIN_PROV | 1 908 | 2026-01-02 | 0.50 | 33 | 66 |

### 1.4 Impacto — no es cosmético

El campo alimenta `calcularFactorRampup(dias_en_quiebre, es_quiebre_proveedor)` (`rampup.ts`). Con `dias > 120`:
- Quiebre propio → factor **0.00** → `pedir_proveedor = 0` aunque `pedir_sin_rampup > 0`
- Quiebre proveedor → factor **0.50** → `pedir_proveedor` cortado a la mitad

**Ejemplos concretos de SKUs que el motor hoy NO pide por el bug:**

- `ALPCMPRDG4575` (Limpiapies Dog 45x75): vende 1.18 uds/sem, proveedor Idetex tiene 200 uds, pero **pedir=0** por factor 0.0 con motivo `quiebre_propio_muy_largo_evalu`.
- `JSAFAB399P20X` (Sábanas Kobu): `pedir_sin_rampup=4` → **pedir=0**.
- `TXV23QLAT15NG` (Quilt Atenas Negro): `pedir_sin_rampup=32` → **pedir=16** (mitad recortada por factor 0.5).

**Sospecha adicional**: los `primera_venta` de PR3 Fase A están todos en **enero-abril 2026** (coinciden con el rango real de `ventas_ml_cache`). Coherente. El bug es sólo de `dias_en_quiebre`, no de `primera_venta`.

## Hallazgo 2 — $72 M CLP en venta perdida (top 10)

Actualización con top 20: el acumulado sube a **~$117 M CLP** (top 10 = $72 M, top 20 = $117 M). El top 1 sólo (`TEXCCWTILL10P`) representa **$21.9 M CLP** — un 19 % del total top 20.

### 2.1 Top 20 detallado

| # | SKU | Nombre | Acción | Cuadr | ABC/XYZ | Bod | Full | Prov | vel_pre | días_q | q_prov | Perdido CLP |
|---:|---|---|---|---|---|---:|---:|---:|---:|---:|:---:|---:|
| 1 | TEXCCWTILL10P | Cubrecolchón Illusions WP | AG_SIN_PROV | ESTRELLA | A-Z | 0 | 0 | 0 | 27.00 | 1 909 | sí | **21 883 685** |
| 2 | TXV23QLAT20NG | Quilt Atenas 20P Negro | AG_SIN_PROV | ESTRELLA | A-Y | 0 | 0 | 0 | 11.00 | 1 909 | sí | 17 252 778 |
| 3 | TXV23QLAT15NG | Quilt Atenas 15P Negro | AG_SIN_PROV | ESTRELLA | A-Z | 0 | 0 | 0 | 5.25 | 1 931 | sí | 11 387 879 |
| 4 | BOLMATCUERCAF2 | Bolso Matero Café 2c Chico | MANDAR_FULL | ESTRELLA | A-Y | **16** | 0 | null | 7.13 | 1 521 | no | 9 775 440 |
| 5 | TXTPBL105200S | Topper Illusions 1.5P | AG_SIN_PROV | CASHCOW | A-Z | 0 | 0 | 0 | 4.88 | 1 912 | sí | 9 147 148 |
| 6 | TXV23QLRM30GR | Quilt Roma 30P Gris | AG_SIN_PROV | ESTRELLA | A-Y | 0 | 0 | 0 | 7.13 | 1 917 | sí | 7 880 699 |
| 7 | LITAF400G4PMT | Toallas Family Menta | MANDAR_FULL | ESTRELLA | A-X | **2** | 0 | 0 | 8.44 | 1 494 | sí | 7 255 786 |
| 8 | BOLMATCUERNEGX4 | Bolso Matero Negro 4c | MANDAR_FULL | ESTRELLA | A-Y | **3** | 0 | null | 4.06 | 1 534 | no | 5 618 315 |
| 9 | TXV23QLAT15BE | Quilt Atenas 15P Beige | AG_SIN_PROV | REVISAR | C-Z | 0 | 0 | 0 | 4.00 | 1 932 | sí | 5 149 056 |
| 10 | TXSB144IRK10P | Sábana Rocket 10P | AG_SIN_PROV | ESTRELLA | A-Y | 0 | 0 | 0 | 4.50 | 1 915 | sí | 4 384 584 |
| 11 | LITAF400G4POV | Toallas Family Olivo | AG_SIN_PROV | VOLUMEN | C-Z | 0 | 0 | 0 | 3.44 | 1 909 | sí | 4 100 785 |
| 12 | TXV23QLRM20OV | Quilt Roma 20P Olivo | MANDAR_FULL | REVISAR | C-Y | **14** | 0 | 200 | 2.73 | 1 521 | no | 3 354 608 |
| 13 | 9788471511348 | Biblia Normal | MANDAR_FULL | ESTRELLA | A-X | **23** | 0 | null | 18.27 | 467 | no | 3 220 742 |
| 14 | TXV25QLBRBG20 | Quilt Breda 20P Beige | AG_PEDIR | ESTRELLA | A-Z | 0 | 0 | 30 | 2.38 | 1 909 | no | 2 999 566 |
| 15 | JSAFAB436P20W | Sábanas Campine 2.0 | AG_PEDIR | REVISAR | C-Z | 0 | 0 | null | 1.50 | 1 910 | no | 2 671 715 |
| 16 | JSCNAE119P20A | Sábanas Rainforest 2.0 | AG_PEDIR | REVISAR | C-Y | 0 | 0 | null | 1.70 | 1 957 | no | 2 529 192 |
| 17 | TXSB144ILD15P | Sábana Lady 15P | AG_SIN_PROV | ESTRELLA | A-Y | 0 | 0 | 0 | 2.38 | 1 929 | sí | 2 219 430 |
| 18 | TX2ALIMFP5070 | Pack Almohadas Premium | MANDAR_FULL | REVISAR | B-Z | **46** | 0 | 5 000 | 3.25 | 470 | no | 1 861 979 |
| 19 | TXV23QLRM20GR | Quilt Roma 20P Gris | MANDAR_FULL | REVISAR | B-Y | **26** | 0 | 200 | 5.13 | 521 | no | 1 811 653 |
| 20 | TXV24QLBRMR25 | Quilt Bruselas Marengo 25P | MANDAR_FULL | ESTRELLA | A-Y | **4** | 0 | 15 | 3.65 | 980 | no | 1 763 563 |

**Total top 20: ~$117 M CLP.** Ninguno con `es_est=true` (todos con margen real, no fallback 25 %).

### 2.2 Breakdown por acción

| Acción | n |
|---|---:|
| AGOTADO_SIN_PROVEEDOR | 9 |
| MANDAR_FULL | 8 |
| AGOTADO_PEDIR | 3 |

**Sorpresa**: 8 de 20 son **MANDAR_FULL** (tienen stock en bodega, lo están esperando para enviar a Full). No son "perdidos por falta de mercadería" — son perdidos por **no haber mandado a Full a tiempo**. Acción directa, bajo costo de corrección.

### 2.3 TEXCCWTILL10P — ficha

- **`proveedor_catalogo`** ✅ existe. Proveedor: **Idetex**, precio_neto $4 500, inner_pack 10, `stock_disponible = 0` (desde 2026-04-09 última actualización).
- **`productos`** ✅ existe. Proveedor: Idetex, última actualización 2026-02-26.
- **Últimas ventas** (cache ML): 5 ventas entre 2026-03-19 y 2026-03-23, todas de 1 unidad — vendió hasta la semana del 23/mar, luego cero.
- **`vel_ponderada=5.78` pero `vel_pre_quiebre=27`**: el motor ya detectó el quiebre, preservó la vel histórica alta y la usa para imputar venta_perdida.

**Diagnóstico**: proveedor Idetex reporta 0 unidades hace 9 días. El SKU está genuinamente bloqueado en la cadena, no es ruido de precio ni SKU fantasma. La pérdida $21.9 M se imputó con `oportunidad_perdida_es_estimacion=false` — viene de margen real.

## Hallazgo 3 — 74.5 % del catálogo es clase Z

Universo real para modelar: **162 SKUs Z con `vel>0`** (los 237 Z con `vel=0` ya caen en INACTIVO/DEAD_STOCK sin necesidad de mejor modelo).

### 3.1 Perfilado — composición del grupo

| Segmento | n | % de 162 |
|---|---:|---:|
| **SKU nuevo** (`dias_desde_primera_venta < 60`) | 77 | 47.5 % |
| **Sin venta últimos 30 días** (dead/dormant) | 18 | 11.1 % |
| **Marcado `es_estacional=true`** (PR4 Fase 1) | 3 | 1.9 % |
| **Intermitencia real** (≥5 sem con venta en 15) | 74 | 45.7 % |
| **Pocas ventas** (1-4 sem en 15) | 79 | 48.8 % |
| **Cero ventas en 15 sem** | 9 | 5.6 % |

(Los segmentos no son exclusivos — un SKU puede ser nuevo y tener intermitencia real a la vez.)

**Disjunto** (categoría única, prioridad nuevo > estacional > ambiguo):

| Categoría | n |
|---|---:|
| Solo nuevos (sin flag estacional) | 77 |
| Solo estacionales (no nuevos) | 3 |
| **Ambiguos sin categoría** (no nuevos ni estacionales) | 82 |

Los **82 ambiguos** son los candidatos legítimos de TSB. Los 77 nuevos caen bajo la puerta 60d que PR3 ya les asignó SMA. Los 3 estacionales ya están marcados.

### 3.2 Simulación — subir umbral CV de 1.0 a 1.5

| Umbral | Saldrían de Z | Quedarían Z |
|---|---:|---:|
| `cv < 1.0` (actual) | — | 162 |
| `cv < 1.5` (propuesto) | **75** | 87 |

Subir el umbral dejaría el universo Z "vivo" en **87 SKUs** (46 % menos). Los 75 que saldrían pasarían a Y con comportamiento SMA estándar, sin tratamiento TSB.

### 3.3 Columna `z_razon` — no existe

Grep: 0 filas en `information_schema.columns` con `column_name='z_razon'`. Habría que agregarla.

**Opciones de valor**:
- `'z_intermitente'` — caso canónico TSB.
- `'z_nuevo'` — ≤ 60d desde primera venta.
- `'z_estacional'` — redundante con `es_estacional=true`, podría omitirse.
- `'z_escala'` — venta regular pero volumen bajo (CV alto por σ/media chica).
- `'z_obsolescencia'` — decay monotónico.

## Recomendación

### Priorización de PRs

**1º PR5 — Fix `dias_en_quiebre` (máxima prioridad, bloqueo financiero real)**

- **Bug demostrado**, con impacto en **pedir_proveedor de 38 SKUs**. Los SKUs que no se piden por factor_rampup=0.0 incluyen varios del top 20 perdidos ($21.9 M + $17.2 M + $11.4 M...). Cada día que pasa sin fix, el motor recomienda no pedir SKUs que hoy deberían pedirse (ej. Limpiapies Dog — proveedor tiene 200 uds, pedido recomendado por el motor: 0).
- **Scope acotado**: editar la rama de incremento en `intelligence.ts:1105` para usar diferencia en días calendario entre `prev.updated_at` y `hoy`, o derivar fresh desde `primerQuiebre` en lugar de incrementar. Tests unitarios en `src/lib/__tests__/intelligence-*.test.ts`.
- **Costo estimado**: 1 PR chico, medio día de trabajo. Requiere 1 recálculo post-merge para re-nivelar los 38 SKUs.
- **Efecto inmediato**: al menos 20+ SKUs pasan de `pedir=0` a `pedir>0`. Algunos van a activar alertas `necesita_pedir` nuevas.

**2º PR6 — Dashboard "Agotado / Venta Perdida"**

- Los 8 **MANDAR_FULL del top 20** son la fruta baja: $31.4 M CLP perdidos en SKUs con stock en bodega esperando envío a Full (BOLMATCUERCAF2, LITAF400G4PMT, BOLMATCUERNEGX4, TXV23QLRM20OV, 9788471511348, TX2ALIMFP5070, TXV23QLRM20GR, TXV24QLBRMR25). No hace falta esperar fix del bug ni tocar modelo de forecast — es acción operativa del operador.
- Un tab dedicado con la lista de top 20 perdidos + filtros + botón "marcar revisado" + trail auditable. Equivalente al tab Accuracy de PR2 pero para pérdidas. No requiere migración (lee datos existentes).
- **Impacto**: acelera la recuperación de los $31.4 M MANDAR_FULL. Los otros $86 M (AGOTADO_*) dependen de decisiones comerciales (discontinuar / re-incorporar proveedor).

**3º PR7 — Reclasificación Z (bajo prioridad, efecto modelado)**

- **Agregar `z_razon`** pero con la lección de PR4 Fase 1: detección manual, no automática. La clasificación automática requiere más historia.
- Subir umbral a CV ≥ 1.5 reclasificaría 75 SKUs a Y — estos 75 quedarían fuera del universo TSB shadow (hoy dormant de todas formas) pero con SMA estándar sin puerta de 60d. **Bajo impacto operativo inmediato** hasta que haya datos reales de accuracy post-2026-05-18.
- Puede esperar a PR4 Fase 2 (~julio 2026) cuando haya 26+ semanas de historia y podamos distinguir categorías con rigor.

### Orden definitivo recomendado

**PR5 (fix bug) → PR6 (dashboard pérdidas) → esperar 2026-05-18 → PR7 si sigue haciendo falta.**

### Hallazgo colateral crítico

⚠️ **La acción `EXCESO` en SKUs AGOTADOS_SIN_PROVEEDOR**: `TXV23QLAT15AQ` aparece con `accion='EXCESO'` y `dias_q=2 068`. Revisando: tiene `dias_en_quiebre` alto pero en realidad si está en EXCESO significa que TIENE stock. Revisar la regla — probablemente el quiebre se detectó en semanas pasadas y el motor mantuvo el contador creciendo aunque ya hay stock. Otros ejemplos en los 38: `JSAFAB425P20S` EXCESO con dias_q=1648, `JSAFAB433P10W` EXCESO con dias_q=2066. Son **casos donde `dias_en_quiebre > 0` coexiste con `accion='EXCESO'` o `accion='MANDAR_FULL'`**, lo cual no debería pasar (el SKU no está en quiebre hoy pero el contador siguió incrementando).

**Implicación**: el bug de §1 no sólo infla los contadores — también mantiene el flag `enQuiebreAhora=true` en SKUs que ya se repusieron. Verificar rama `else if (prev && (prev.dias_en_quiebre ?? 0) > 0 && stFull > 0)` en `intelligence.ts:1125` — debería resetear cuando el SKU vuelve a tener stock, pero algo no reset en estos casos. Parte del mismo PR5.

---

**Generado**: 2026-04-18
**Método**: queries directas a Supabase + lectura `intelligence.ts` + `rampup.ts`.
**Sin código escrito. Sin migración aplicada.**
