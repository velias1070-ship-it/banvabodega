# Warehouse Management System
> BANVA / bodega
Sistema de inventario para bodega con arquitectura multi-agente IA. Diseñado para operaciones de e-commerce en MercadoLibre Chile.
`Next.js 14` `Supabase` `TypeScript` `Vercel` `PWA`
---
## Estado del refactor
**Sprints 0-8 completados** (refactor del motor de inteligencia, 2026 Q1-Q2).
- **Motor nuevo** (vistas SQL `v_safety_stock`, `v_compras_pendientes`, `v_reposicion_explain`, `v_sku_alertas`, `v_sku_explanation`) es **default operativo desde 2026-05-05** (Sprint 8 Fase 1).
- **Motor viejo** (`src/lib/intelligence.ts`, `flex-full.ts`, `rampup.ts`) marcado `@deprecated`. Sigue corriendo el cron `/api/intelligence/recalcular` solo para alimentar columnas legacy. Borrar tras Sprint 9+ (cooldown 30d).
- Doctrina vinculante: [`/docs/policies/motor-canonico.md`](docs/policies/motor-canonico.md).
- Guía operativa: [`/docs/guides/uso-motor-nuevo.md`](docs/guides/uso-motor-nuevo.md).
- Sprint docs: [`/docs/sprints/sprint-7.md`](docs/sprints/sprint-7.md), [`/docs/sprints/sprint-8-cleanup.md`](docs/sprints/sprint-8-cleanup.md).
---
## Interfaces
| Operador | Admin |
|----------|-------|
| Escaneo rápido, búsqueda de productos, mapa de bodega | Dashboard, SKUs, ubicaciones, movimientos, conteos cíclicos |
---
## Desarrollo local
```bash
npm install
npm run dev
# → localhost:3000
```
---
## Deploy
**GitHub + Vercel** — git push → importar en Vercel
**Vercel CLI** — `vercel --prod`
---
## Estructura
```
src/
  app/
    operador/
    admin/
    page.tsx
    layout.tsx
    globals.css
  lib/
    store.ts
```
---
## Instalar como app móvil
**iPhone** — Safari → Compartir → Agregar a inicio
**Android** — Chrome → Instalar app
