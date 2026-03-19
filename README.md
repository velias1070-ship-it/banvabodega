# Warehouse Management System
> BANVA / bodega
Sistema de inventario para bodega con arquitectura multi-agente IA. Diseñado para operaciones de e-commerce en MercadoLibre Chile.
`Next.js 14` `Supabase` `TypeScript` `Vercel` `PWA`
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
