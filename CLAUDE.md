# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

BANVA Bodega — WMS (Warehouse Management System) para BANVA Chile. Controla inventario, recepciones de mercadería, picking de pedidos Flex MercadoLibre, conteos cíclicos, despacho, y módulos financieros (ProfitGuard, SII, MercadoPago).

## Commands

```bash
npm run dev          # Next.js dev server → localhost:3000
npm run build        # Production build (también valida TypeScript)
npm run test         # Vitest run (una vez)
npm run test:watch   # Vitest watch mode
```

No hay linter configurado. `npm run build` es la validación principal de tipos.

## Stack

- **Framework:** Next.js 14 (App Router) + React 18 + TypeScript
- **DB:** Supabase (PostgreSQL) — cliente con anon key, sin auth server-side
- **Estilos:** CSS custom dark theme en `globals.css` (no component library)
- **Libs:** Scanbot Web SDK (barcode), jsPDF, QRCode, JSBarcode, JSZip, xlsx, pdfjs-dist
- **Deploy:** Vercel con crons cada minuto para syncs ML/stock

## Architecture

### Core lib files (8k+ LOC total)

| Archivo | LOC | Rol |
|---|---|---|
| `src/lib/store.ts` | ~3100 | Estado en memoria + bridge a db.ts. Composición de ventas, cálculo de stock, detección de discrepancias |
| `src/lib/db.ts` | ~2700 | CRUD Supabase (todas las queries). Interfaces `DB*` para tipos |
| `src/lib/ml.ts` | ~2300 | Integración MercadoLibre API (server-side only). OAuth, sync, stock |
| `src/lib/intelligence.ts` | — | Lógica de inteligencia de negocio (velocidad, reposición) |
| `src/lib/agents-db.ts` | — | Persistencia del sistema de agentes IA |
| `src/lib/reposicion.ts` | — | Cálculos de reposición de stock |
| `src/lib/supabase.ts` | — | Cliente Supabase client-side (singleton) |
| `src/lib/supabase-server.ts` | — | Cliente Supabase server-side (singleton) |

### API Routes (`src/app/api/`)

| Ruta | Descripción |
|---|---|
| `ml/` | MercadoLibre: OAuth, webhook, sync órdenes, stock sync, etiquetas, Flex |
| `agents/` | Sistema multi-agente IA: chat, cron, rules, feedback |
| `profitguard/` | Análisis de rentabilidad por orden |
| `mp/` | MercadoPago sync |
| `sii/` | Integración SII Chile (boletas, RCV, sync) |
| `intelligence/` | Queries de inteligencia de negocio |
| `orders/` | Historial de órdenes |
| `sheet/` | Exportación Excel |

### UI (dos interfaces separadas)

- **`/operador`** — Mobile-first (max-width 480px, PWA). Picking, recepciones, conteos, facturas
- **`/admin`** — Full-width con sidebar. Dashboard, inventario, productos, posiciones, configuración, mapa de bodega, QR codes

### Vercel Crons

Configurados en `vercel.json`. Sync de ML, stock y ProfitGuard se ejecutan cada 1-5 minutos.

### Migraciones SQL

Archivos `supabase-v*.sql` en la raíz. Se ejecutan manualmente en Supabase SQL Editor. Numerados incrementalmente (v2 → v33+).

## Conventions

- Todo el código en español (tablas, variables de dominio, UI)
- Archivos `"use client"` por defecto; server-side solo en `api/` y `lib/ml.ts`
- Queries directas via `sb.from("tabla").select/upsert/update/delete` — no ORM
- Interfaces `DB*` en `db.ts` para tipos Supabase; sin prefijo en `store.ts`
- Batch upserts en chunks de 500 registros
- Supabase retorna PromiseLike, no Promise: usar try/catch o void, NUNCA `.catch()`
- Todo cambio de stock DEBE generar un movimiento via `registrar_movimiento_stock()` — nunca updateStock silencioso
- Iconos con emojis nativos (no icon library)
- Inline styles extensivos para variaciones; CSS classes solo para patrones repetidos

## MercadoLibre API

Ante cualquier duda sobre endpoints, parámetros o flujos de la API de ML, consultar: https://developers.mercadolibre.cl

## Testing

Vitest configurado. Un test existente en `src/lib/__tests__/reposicion.test.ts`. Scripts de soporte en `scripts/` para clonar datos y schema de test.

## Detailed Rules

Ver `.claude/rules/` para reglas por dominio:

- [supabase.md](.claude/rules/supabase.md) — esquema, queries, RLS
- [ui-ux.md](.claude/rules/ui-ux.md) — patrones UI, mobile-first
- [meli-api.md](.claude/rules/meli-api.md) — integración MercadoLibre
- [security.md](.claude/rules/security.md) — autenticación, roles, permisos
- [testing.md](.claude/rules/testing.md) — estrategia de testing
- [agents.md](.claude/rules/agents.md) — setup multi-máquina, cómo contactar al agente Viki en el droplet

## Git

Siempre trabaja directamente en la branch main. No crees branches separadas. Haz commit y push directo a main.

## Reuse-first workflow

Antes de crear un recurso nuevo (función en `src/lib/*`, API route en `src/app/api/*`, interface `DB*`, RPC/migración SQL, hook, componente admin/operador, query Supabase recurrente), **invocar el subagente `reuse-scout`** con una descripción corta de lo que se va a crear. Si el scout devuelve `REUSE` o `EXTEND`, seguir esa pista antes de escribir código nuevo.

Aplica cuando el cambio agrega ≥20 LOC de lógica nueva. Para fixes pequeños o ajustes puntuales no hace falta.

Para barrido periódico de duplicación/código muerto: `/hygiene`.
