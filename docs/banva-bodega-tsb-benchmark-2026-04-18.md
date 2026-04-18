# Benchmark TSB retroactivo — 2026-04-18

Generado: 2026-04-18T00:17:52.463Z
Script: `scripts/benchmark-tsb.ts`

## Resumen

- SKUs Z maduros evaluados: **167**
- Pares (SKU, lunes): 216
- SKUs con ≥2 semanas con venta: 26
- SKUs con WMAPE calculable: **26**
- Pares con `en_quiebre=NULL` (reconstruidos): 216/216 — incluidos (el criterio "sólo `en_quiebre=false`" queda desactivado hasta que haya datos reales post 2026-05-18).

## Criterios

| # | Criterio | Valor | Umbral | Veredicto |
|---|---|---|---|---|
| 1 | Δ WMAPE mediano (SMA − TSB) | 5.1% (SMA=90.5%, TSB=85.4%) | ≥ 15 % | ❌ FALLA |
| 2 | Regresiones ESTRELLA/CASHCOW-Z | 3 / 8 | 0 | ❌ FALLA |
| 3 | Bias TSB mediano / vel | 20.1% | > −20 % | ✅ PASA |
| 4 | SMA<0.5 & TSB>3 | 0 / 26 (0.0%) | < 10 % | ✅ PASA |

**Veredicto global: TSB ❌ NO PASA**

## Desglose por cuadrante

| Cuadrante-Z | n | WMAPE SMA | WMAPE TSB | Δ | Gana |
|---|---:|---:|---:|---:|---|
| ESTRELLA-Z | 6 | 90.1% | 83.1% | −7.0% | TSB |
| CASHCOW-Z | 2 | 361.2% | 502.5% | +141.3% | SMA |
| VOLUMEN-Z | 1 | 105.1% | 94.9% | −10.3% | TSB |
| REVISAR-Z | 17 | 89.5% | 83.6% | −5.9% | TSB |

## Top 10 SKUs donde TSB **gana** más

| SKU | Nombre | Cuadrante | ABC | n | WMAPE SMA | WMAPE TSB | Δ |
|---|---|---|---|---:|---:|---:|---:|
| TXSC2PVLVERSF | Set Cortinas Velo Lino Verde Soft | REVISAR | B | 4 | 115.9% | 83.6% | +32.3% |
| JSAFAB422P20S | Jgo Sabanas AF 144H 50%Alg Tropico Rosa  | REVISAR | B | 4 | 104.0% | 77.1% | +26.8% |
| TXSB144IUN15P | Sabana Illusions 144H Infantil Unicornio | REVISAR | C | 4 | 52.7% | 31.4% | +21.3% |
| TXV23QLAT15NG | Quilt Atenas 15P Negro | ESTRELLA | A | 4 | 156.6% | 139.8% | +16.8% |
| JSECBQ008P20A | Jgo Sabanas EC 200H 100%Alg Liso Lila 2. | ESTRELLA | A | 4 | 57.8% | 41.7% | +16.1% |
| TXSB144ILD15P | Sabana Illusions 144H Infantil Lady 15P | ESTRELLA | A | 4 | 91.9% | 79.1% | +12.8% |
| JSAFAB400P20X | Jgo Sabanas AF 144H 50%Alg Est Dober 2.0 | REVISAR | C | 4 | 90.7% | 78.4% | +12.3% |
| TXSC2PVLBEIGE | Set Cortinas Velo Lino Beige | VOLUMEN | B | 4 | 105.1% | 94.9% | +10.3% |
| ALPCMPRBD4575 | Limpiapies Coco 45 x 75 Birds | ESTRELLA | A | 4 | 137.0% | 128.8% | +8.3% |
| JSCNAE140P20Z | Jgo Sabanas CN 200H 60%Alg Est Branch 2. | REVISAR | C | 4 | 129.7% | 123.2% | +6.4% |

## Top 10 SKUs donde TSB **pierde** más

| SKU | Nombre | Cuadrante | ABC | n | WMAPE SMA | WMAPE TSB | Δ |
|---|---|---|---|---:|---:|---:|---:|
| TXTPBL1520020 | Topper Illusions 2.0 P | CASHCOW | A | 4 | 627.9% | 907.0% | -279.1% |
| AINHO095X133F | Alfombra Infantil Happy Owl 095 x 133 Fu | REVISAR | C | 4 | 84.3% | 92.5% | -8.2% |
| TXV23QLAT25GR | Quilt Atenas 25P Gris | REVISAR | C | 2 | 77.1% | 83.8% | -6.7% |
| TXTPBL105200S | Topper Illusions 1.5 P | CASHCOW | A | 4 | 94.6% | 98.1% | -3.5% |
| TXSB144ISY10P | Sabana Illusions 144H Infantil Starry 10 | ESTRELLA | A | 4 | 67.7% | 70.4% | -2.7% |
| JSCNAE179P20S | Jgo Sabanas CN 200H 60%Alg Estamp Noir 2 | REVISAR | C | 4 | 93.8% | 96.2% | -2.4% |
| TXS2CTBO135ST | Set Cortinas Black Out Stone | REVISAR | C | 3 | 74.0% | 74.4% | -0.4% |
| JSCNAE141P20Z | Jgo Sabanas CN 200H 60%Alg Est Glow 2.0  | REVISAR | C | 3 | 89.5% | 89.6% | -0.1% |
| JSCNAE175P20S | Jgo Sabanas CN 200H 60%Alg Estamp Drift  | ESTRELLA | A | 4 | 88.4% | 87.1% | +1.2% |
| TXSB144IST15P | Sabana Illusions 144H Infantil Stars 15P | REVISAR | C | 4 | 72.7% | 70.5% | +2.2% |

## Distribución Δ (WMAPE_SMA − WMAPE_TSB)

- `Δ ≤ −50%      ` n=1
- `−50% a −30%   ` n=0
- `−30% a −10%   ` n=0
- `−10% a +10%   ` n=17
- `+10% a +30%   ` n=7
- `+30% a +50%   ` n=1
- `Δ ≥ +50%      ` n=0

## Recomendación

❌ TSB NO pasó. Mantener como columna informativa en shadow. Issues:

- **Mejora WMAPE insuficiente (Δ=5.1%, necesita ≥15%)**: TSB no es suficientemente mejor que SMA en mediana. Probar ajustar grid α/β, o evaluar SBA.
- **3 regresión(es) en ESTRELLA/CASHCOW-Z**: TXTPBL105200S, TXTPBL1520020, TXSB144ISY10P. TSB empeora los SKUs que más importan. Revisar esos casos manualmente; probablemente sean lanzamientos que cumplieron 60d pero siguen en ramp-up. Posible: ampliar puerta a 90d.

## Tabla completa — 26 SKUs

| SKU | Nombre | Cuadrante | ABC | n | Σactual | WMAPE SMA | WMAPE TSB | Bias TSB | Bias/vel |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| TXTPBL105200S | Topper Illusions 1.5 P | CASHCOW | A | 4 | 23 | 94.6% | 98.1% | -0.36 | -32.8% |
| TXSC2PVLVERSF | Set Cortinas Velo Lino Verde Soft | REVISAR | B | 4 | 3 | 115.9% | 83.6% | 0.36 | 37.5% |
| LIB-ES-12 | Libro esperanza | REVISAR | C | 4 | 2 | 109.3% | 105.8% | -0.29 | -105.1% |
| AINHO095X133F | Alfombra Infantil Happy Owl 095 x 133 Fu | REVISAR | C | 4 | 2 | 84.3% | 92.5% | 0.22 | 28.1% |
| TXSC2PVLBEIGE | Set Cortinas Velo Lino Beige | VOLUMEN | B | 4 | 7 | 105.1% | 94.9% | -0.38 | -6.5% |
| TXS2CTBO135PE | Set Cortinas Black Out Perla | REVISAR | B | 4 | 3 | 140.3% | 135.3% | -0.31 | -20.7% |
| JSCNAE140P20Z | Jgo Sabanas CN 200H 60%Alg Est Branch 2. | REVISAR | C | 4 | 2 | 129.7% | 123.2% | 0.26 | 19.6% |
| TXV23QLAT15NG | Quilt Atenas 15P Negro | ESTRELLA | A | 4 | 12 | 156.6% | 139.8% | -3.53 | -349.8% |
| JSCNAE141P20Z | Jgo Sabanas CN 200H 60%Alg Est Glow 2.0  | REVISAR | C | 3 | 2 | 89.5% | 89.6% | -0.15 | -18.3% |
| TXTPBL1520020 | Topper Illusions 2.0 P | CASHCOW | A | 4 | 2 | 627.9% | 907.0% | -4.53 | -1030.7% |
| JSCNAE179P20S | Jgo Sabanas CN 200H 60%Alg Estamp Noir 2 | REVISAR | C | 4 | 3 | 93.8% | 96.2% | 0.39 | 48.4% |
| JSECBQ008P20A | Jgo Sabanas EC 200H 100%Alg Liso Lila 2. | ESTRELLA | A | 4 | 6 | 57.8% | 41.7% | 0.45 | 68.8% |
| TXSB144ISY10P | Sabana Illusions 144H Infantil Starry 10 | ESTRELLA | A | 4 | 44 | 67.7% | 70.4% | 7.03 | 72.7% |
| TXV24QLBRBA15 | Quilt Bruselas Bars Single | REVISAR | B | 3 | 6 | 12.4% | 8.3% | -0.11 | -3.4% |
| ALPCMPRBD4575 | Limpiapies Coco 45 x 75 Birds | ESTRELLA | A | 4 | 6 | 137.0% | 128.8% | 0.30 | 20.6% |
| JSCNAE175P20S | Jgo Sabanas CN 200H 60%Alg Estamp Drift  | ESTRELLA | A | 4 | 7 | 88.4% | 87.1% | -0.07 | -10.5% |
| ALPCMPRSH4575 | Limpiapies Coco 45 x 75 Shells | REVISAR | C | 2 | 3 | 69.8% | 64.6% | 0.97 | 193.8% |
| JSAFAB400P20X | Jgo Sabanas AF 144H 50%Alg Est Dober 2.0 | REVISAR | C | 4 | 8 | 90.7% | 78.4% | 0.98 | 127.6% |
| JSAFAB422P20S | Jgo Sabanas AF 144H 50%Alg Tropico Rosa  | REVISAR | B | 4 | 7 | 104.0% | 77.1% | 0.27 | 41.4% |
| TXV23QLAT15AQ | Quilt Atenas 15P Aqua | REVISAR | C | 4 | 3 | 90.3% | 86.9% | -0.09 | -38.2% |
| TXV23QLAT25GR | Quilt Atenas 25P Gris | REVISAR | C | 2 | 3 | 77.1% | 83.8% | 1.26 | 44.6% |
| TXSB144IST15P | Sabana Illusions 144H Infantil Stars 15P | REVISAR | C | 4 | 11 | 72.7% | 70.5% | -0.03 | -5.1% |
| TXSB144ILD15P | Sabana Illusions 144H Infantil Lady 15P | ESTRELLA | A | 4 | 10 | 91.9% | 79.1% | 0.63 | 66.8% |
| TXS2CTBO135ST | Set Cortinas Black Out Stone | REVISAR | C | 3 | 6 | 74.0% | 74.4% | 1.49 | 122.0% |
| TXSB144IUN15P | Sabana Illusions 144H Infantil Unicornio | REVISAR | C | 4 | 3 | 52.7% | 31.4% | 0.03 | 8.5% |
| JSAFAB417P20W | Jgo Sabanas AF 144H 50%Alg Lavanda Rosa  | REVISAR | B | 4 | 6 | 78.3% | 73.3% | 1.00 | 84.9% |
