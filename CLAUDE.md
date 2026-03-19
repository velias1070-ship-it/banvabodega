# BANVA Bodega — WMS (Warehouse Management System)

Sistema de gestión de bodega para BANVA (Chile). Controla inventario, recepciones de mercadería, picking de pedidos Flex MercadoLibre, conteos cíclicos y despacho.

## Stack

- **Framework:** Next.js 14 (App Router) + React 18 + TypeScript
- **Backend:** API Routes en `src/app/api/`; no hay middleware ni auth server-side
- **DB:** Supabase (PostgreSQL) — cliente con anon key, sin auth de usuarios
- **Estilos:** CSS custom con variables en `globals.css` (dark theme). Fonts: Outfit + JetBrains Mono
- **Libs:** Scanbot Web SDK (barcode), jsPDF, QRCode, JSBarcode, JSZip
- **Deploy:** Vercel

## Estructura clave

```
src/lib/db.ts        → CRUD Supabase (todas las queries)
src/lib/store.ts     → Estado en memoria + bridge a db.ts
src/lib/ml.ts        → Integración MercadoLibre API (server-side)
src/lib/supabase.ts  → Cliente Supabase (client-side singleton)
src/app/operador/    → UI operador (mobile-first, max-width 480px)
src/app/admin/       → Panel admin (sidebar + tabs)
src/app/api/ml/      → API Routes para ML (OAuth, webhooks, sync)
supabase-v*.sql      → Migraciones SQL incrementales
```

## Convenciones

- Todo el código en español (nombres de tablas, variables de dominio, UI)
- Archivos `"use client"` por defecto; server-side solo en `api/` y `lib/ml.ts`
- Queries directas via `sb.from("tabla").select/upsert/update/delete` — no ORM
- Interfaces `DB*` en `db.ts` para tipos de Supabase; interfaces sin prefijo en `store.ts`
- Batch upserts en chunks de 500 registros

## MercadoLibre API

Ante cualquier duda sobre endpoints, parámetros, respuestas o flujos de la API de MercadoLibre, consultar la documentación oficial: https://developers.mercadolibre.cl

## Reglas detalladas

Ver `.claude/rules/` para reglas por dominio:

- [supabase.md](.claude/rules/supabase.md) — esquema, queries, RLS
- [ui-ux.md](.claude/rules/ui-ux.md) — patrones UI, mobile-first
- [meli-api.md](.claude/rules/meli-api.md) — integración MercadoLibre
- [security.md](.claude/rules/security.md) — autenticación, roles, permisos
- [testing.md](.claude/rules/testing.md) — estrategia de testing


## Git
Siempre trabaja directamente en la branch main. No crees branches separadas. Haz commit y push directo a main.
