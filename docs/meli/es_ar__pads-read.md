---
source_url: https://developers.mercadolibre.cl/es_ar/pads-read
title: "Developers"
selector: "main"
synced_at: 2026-04-13T12:20:39.129Z
---

Documentación Mercado Libre

Descubre toda la información que debes conocer sobre las APIs de Mercado Libre.

![circulos azuis em degrade](https://http2.mlstatic.com/storage/developers-site-cms-admin/DevImgs/230801158836-ImgMS--1-.png)

Documentación

Última actualización 18/02/2026

## Product Ads

Con los siguientes endpoints de Product Ads puedes monitorear campañas, anuncios y métricas. Existen dos modalidades de gestión de anuncios en Product Ads.

-   **Automático**: Product Ads elige las publicaciones con un buen nivel de ventas en Mercado Libre y las muestra en las primeras ubicaciones de los resultados de búsqueda. Puedes agregar o quitar publicaciones de tu campaña en forma manual. Cuando empiezas a usar Product Ads utilizarás el modo automático por defecto.
-   **Personalizado**: podrás crear múltiples campañas para agrupar tus anuncios, asignar y configurar el presupuesto y el objetivo de cada una. Este es el modo ideal para gestionar tus anuncios, porque te permite tener más control sobre tus campañas y hacer ajustes en base a su desempeño.

Importante:

Informamos que, tras el período de transición finalizado Septiembre de 2025, los endpoints legados de Product Ads listados a continuación serán desactivados permanentemente el **26 de febrero de 2026**.  
  
A partir de esta fecha, las llamadas a estos recursos devolverán un error **(404 Not Found)**. Si tu aplicación aún utiliza alguno de estos endpoints, adapta inmediatamente tu desarrollo para evitar interrupciones en el servicio.  
  
Solo los endpoints publicados en la documentación de Product Ads tienen soporte.  
  
**Endpoints que serán descontinuados:**

-   **GET /advertising/product\_ads/items/$ITEM\_ID**
-   **GET /advertising/$ADVERTISER\_SITE\_ID/product\_ads/items/$ITEM\_ID**
-   **GET /advertising/advertisers/$ADVERTISER\_ID/product\_ads/items**
-   **GET /advertising/$ADVERTISER\_SITE\_ID/advertisers/$ADVERTISER\_ID/product\_ads/items/search**
-   **GET /advertising/product\_ads/campaigns/$CAMPAIGN\_ID**
-   **GET /advertising/advertisers/$ADVERTISER\_ID/product\_ads/campaigns**
-   **GET /advertising/product\_ads/campaigns/$CAMPAIGN\_ID/metrics**
-   **GET /advertising/product\_ads\_2/campaigns/$CAMPAIGN\_ID/metrics**
-   **GET /advertising/product\_ads/campaigns/$CAMPAIGN\_ID/ads/metrics**
-   **GET /advertising/product\_ads\_2/campaigns/$CAMPAIGN\_ID/ads/metrics**
-   **GET /advertising/product\_ads/ads/search**

  

## Consultar anunciante

**Importante:**

Para usar Product Ads, un usuario debe:  
\- Tener reputación amarilla o superior.  
\- Que hayan transcurrido por lo menos 15 días desde el registro en Mercado Libre.  
\- Tener un mínimo de ventas en Mercado Libre (1 para empresas, 10 para individuos).  
\- No tener ninguna factura vencida en Mercado Libre.

Los anunciantes (advertiser\_id) son quienes invierten un presupuesto para la creación y distribución de anuncios publicitarios, con el objetivo de promocionar sus productos o servicios. Consulta el listado de anunciantes que tiene acceso a un usuario, según el tipo de producto que se requiera.

  

**Parámetros obligatorios:**

-   **product\_id:** tipo de producto. Valores disponibles: PADS (Product Ads), DISPLAY, BADS (Brand Ads).

**Llamada:**

```javascript
curl -X GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'Content-Type: application/json' -H 'Api-Version: 1' https://api.mercadolibre.com/advertising/advertisers?product_id=$PRODUCT_ID
```

**Ejemplo:**

```javascript
curl -X GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'Content-Type: application/json' -H 'Api-Version: 1' https://api.mercadolibre.com/advertising/advertisers?product_id=PADS
```

**Respuesta:**

```javascript
{
    "advertisers": [
        {
            "advertiser_id": 000,
            "site_id": "MLB",
            "advertiser_name": "Advertiser AAA",
            "account_name": "MLB - XZY"
        },
        {
            "advertiser_id": 111,
            "site_id": "MLM",
            "advertiser_name": "Advertiser BBB",
            "account_name": "MLM - XYZ"
        },
        {
            "advertiser_id": 222,
            "site_id": "MLA",
            "advertiser_name": "Advertiser CCC",
            "account_name": "MLA - XYZ"
        },
        {
            "advertiser_id": 333,
            "site_id": "MLC",
            "advertiser_name": "Advertiser DDD",
            "account_name": "MLC - XYZ"
        }
    ]
}
```

**Campos de respuesta:**

-   **advertiser\_id:** identificador del anunciante. Lo utilizarás para el resto de solicitudes.
-   **site\_id:** identificador del país. Consulta la [nomenclatura de los sites de Mercado Libre y sus respectivas monedas](https://api.mercadolibre.com/sites)
-   **advertiser\_name:** nombre del anunciante.
-   **account\_name:** nombre de la cuenta.

Nota:

En caso de recibir el error 404 - No permissions found for user\_id significa que el usuario no tiene habilitado el Producto. El usuario deberá acceder a Mercado Libre > Mi perfil > Publicidad.

**Ejemplo de error:**

```javascript
{
    "status": 404,
    "error": "not_found",
    "description": "No permissions found for user_id 1167130000"
}
```

## Detalle de un anuncio

**Llamada:**

```javascript
curl -X GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' https://api.mercadolibre.com/advertising/$ADVERTISER_SITE_ID/product_ads/ads/$ITEM_ID
```

**Ejemplo:**

```javascript
curl -X GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' https://api.mercadolibre.com/advertising/MLM/product_ads/ads/MLM12345678
```

**Respuesta:**

```javascript
{
  "item_id": "MLM12345678",
  "campaign_id": 0,
  "price": 16999.0,
  "title": "Pantalla Samsung Led Smart Tv De 65 Pulgadas 4k/uhd",
  "status": "X",
  "has_discount": false,
  "catalog_listing": true,
  "logistic_type": "default",
  "listing_type_id": "gold_pro",
  "domain_id": "MLM-TELEVISIONS",
  "date_created": "2024-03-15T14:41:47Z",
  "buy_box_winner": false,
  "tags": [],
  "channel": "marketplace",
  "official_store_id": 111,
  "brand_value_id": "223",
  "brand_value_name": "Marca",
  "condition": "new",
  "current_level": "unknown",
  "deferred_stock": false,
  "picture_id": "ABCD_12345_XS",
  "thumbnail": "http://http2.mlstatic.com/D_870627-1111.jpg",
  "permalink": "https://articulo.mercadolibre.com.mx/MLM111111-2222-3333-4kuhd-_JM",
  "recommended": false,
  "metrics_summary": {
    "clicks": 0,
    "prints": 0,
    "cost": 0.01,
    "cpc": 0.01,
    "acos": 0.01,
    "organic_units_quantity": 0,
    "organic_items_quantity": 0,
    "direct_items_quantity": 0,
    "indirect_items_quantity": 0,
    "advertising_items_quantity": 0,
    "direct_units_quantity": 0,
    "indirect_units_quantity": 0,
    "units_quantity": 0,
    "direct_amount": 0.01,
    "indirect_amount": 0.01,
    "total_amount": 0.01
  }
}
```

## Métricas de campañas

**Importante:**

A partir de **enero de 2026**, las respuestas de las consultas de métricas de campañas comenzarán a incluir el campo **["roas\_target"](https://developers.mercadolibre.com.ar/es_ar/pads-read?nocache=true#M%C3%A9tricas-de-campa%C3%B1as:~:text=INCREASE%20y%20VISIBILITY.-,roas_target%3A,-Retorno%20sobre%20la)**.  
  
Para mejorar el análisis de desempeño, el sistema ahora prioriza el ROAS en lugar del ACOS. El ROAS se enfoca en el retorno directo de la inversión, indicando cuánto gana el vendedor por cada unidad monetaria invertida en publicidad. Las campañas que anteriormente utilizaban el ACOS Objetivo se migraron automáticamente al valor equivalente en ROAS Objetivo.  
  
El campo **acos\_target** seguirá visible **hasta el 30 de marzo de 2026** como una métrica opcional para facilitar la adaptación y la comparación, ya que **roas\_target** es ahora el indicador estándar de performance. Se calcula automáticamente en base al ROAS enviado y a la siguiente fórmula: ACOS = (1/ROAS) X 100.  
  
**Endpoints impactados:**  
El nuevo campo **roas\_target** pasa a devolverse en los siguientes endpoints:

-   Search y métricas de campañas
-   Métricas sumarizadas de campañas
-   Detalle y métricas de una campaña

  

**Parámetros opcionales:**

-   **limit:** límite de elementos a mostrar.
-   **offset:** atributo de paginado de los resultados, permite recorrer las páginas de la lista desde el 0 hasta el múltiplo del total de elementos con el límite por página.
-   **date\_from:** fecha desde (YYYY-MM-DD). Se valida que esté presente si se solicitan metrics.
-   **date\_to:** fecha hasta (YYYY-MM-DD). Se valida que esté presente si se solicitan metrics.
-   **metrics:** lista separada por coma (Ej. clicks, prints). Indica los campos que serán retornados en la respuesta. Valores posibles:  
    clicks, prints, ctr, cost, cost\_usd, cpc, acos, organic\_units\_quantity, organic\_units\_amount, organic\_items\_quantity, direct\_items\_quantity, indirect\_items\_quantity, advertising\_items\_quantity, cvr, roas, sov, direct\_units\_quantity, indirect\_units\_quantity, units\_quantity, direct\_amount, indirect\_amount, total\_amount
-   **aggregation:** agregación por la cual se presentarán los resultados. Por defecto, sum.
-   **aggregation\_type:** Tipo de agregación en la cual se presentarán los resultados. Por defecto, campaign.
-   **metrics\_summary:** solicitas sumarizado de métricas. Debe usarse en conjunto con metrics. Por defecto, false.

Nota:

\- Para todos los endpoints de métricas puedes aplicar el rango de fechas de 90 días hacia atrás.  
\- La información para validar las métricas se actualiza a las 10:00 hrs GMT-3.  
\- Solo se puede solicitar un aggregation\_type a la vez.

### Filtros disponibles

Para utilizar los filtros debes seguir la estructura **?filters\[nombre del filtro\]= valor**.

  

**campaign\_ids**: filtro por id de campañas separado por comas.

**campaign\_id**: filtro por id de una campaña, se obtienen todos los ítems que han estado en la campaña para el rango de fechas.

**status**: estado de las campañas, separado por comas. Valores disponibles: active, paused.

  

## Search y métricas de campañas

Obtén todas las campañas de un anunciante y además sus métricas correspondientes.

  

**Llamada:**

```javascript
curl -X  GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' https://api.mercadolibre.com/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/campaigns/search
```

**Exemplo:**

```javascript
curl -X  GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' 
https://api.mercadolibre.com/advertising/MLA/advertisers/882927/product_ads/campaigns/search?limit=1&offset=0&date_from=2025-12-01&date_to=2025-12-30&metrics=clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,organic_units_amount,organic_items_quantity,direct_items_quantity,indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,direct_units_quantity,indirect_units_quantity,units_quantity,direct_amount,indirect_amount,total_amount
```

**Respuesta:**

```javascript
{{
    "paging": {
        "offset": 0,
        "total": 15,
        "limit": 1
    },
    "results": [
        {
            "id": 355189450,
            "name": "Campaña",
            "status": "active",
            "last_updated": "2025-11-25T21:12:59.000Z",
            "date_created": "2025-11-25T21:12:59.000Z",
            "strategy": "VISIBILITY",
            "acos_target": 50.0,
            "acos_top_search_target": 0.0,
            "roas_target": 2.0,
            "channel": "marketplace",
            "advertiser_id": 882927,
            "salesforce_event_id": 14,
            "budget": 900.0,
            "automatic_budget": false,
            "metrics": {
                "clicks": 0,
                "prints": 0,
                "cost": 0.0,
                "cpc": 0.0,
                "ctr": 0.0,
                "direct_amount": 0.0,
                "indirect_amount": 0.0,
                "total_amount": 0.0,
                "direct_units_quantity": 0,
                "indirect_units_quantity": 0,
                "units_quantity": 0,
                "direct_items_quantity": 0,
                "indirect_items_quantity": 0,
                "advertising_items_quantity": 0,
                "organic_units_quantity": 0,
                "organic_units_amount": 0.0,
                "organic_items_quantity": 0,
                "acos": 0.0,
                "cvr": 0.0,
                "roas": 0.0,
                "sov": 0.0
            }
        }
    ]
}
```

## Métricas diarias de campañas

**Llamada:**

```javascript
curl -X  GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' https://api.mercadolibre.com/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/campaigns/search?limit=2&offset=0&date_from=2024-01-01&date_to=2024-02-28&metrics=clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,organic_units_amount,organic_items_quantity,direct_items_quantity,indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,direct_units_quantity,indirect_units_quantity,units_quantity,direct_amount,indirect_amount,total_amount&aggregation_type=DAILY
```

**Respuesta:**

```javascript
{
   "paging": {
       "total": 50,
       "offset": 0,
       "limit": 2
   },
   "results": [
       {
           "date": "2024-01-01",
           "clicks": 0,
           "prints": 0,
           "ctr": 0.01,
           "cost": 0.01,
           "cpc": 0.01,
           "acos": 0.01,
           "organic_units_quantity": 0,
           "organic_units_amount": 0,
           "organic_items_quantity": 0,
           "direct_items_quantity": 0,
           "indirect_items_quantity": 0,
           "advertising_items_quantity": 0,
           "cvr": 0,
           "roas": 0,
           "sov": 0,
           "direct_units_quantity": 0,
           "indirect_units_quantity": 0,
           "units_quantity": 0,
           "direct_amount": 0.01,
           "indirect_amount": 0.01,
           "total_amount": 0.01
       },
       {
           "date": "2024-01-01",
           "clicks": 0,
           "prints": 0,
           "ctr": 0.01,
           "cost": 0.01,
           "cpc": 0.01,
           "acos": 0.01,
           "organic_units_quantity": 0,
           "organic_units_amount": 0,
           "organic_items_quantity": 0,
           "direct_items_quantity": 0,
           "indirect_items_quantity": 0,
           "advertising_items_quantity": 0,
           "cvr": 0,
           "roas": 0,
           "sov": 0,
           "direct_units_quantity": 0,
           "indirect_units_quantity": 0,
           "units_quantity": 0,
           "direct_amount": 0.01,
           "indirect_amount": 0.01,
           "total_amount": 0.01
       }
   ]
}
```

## Métricas sumarizadas de campañas

Utiliza el mismo endpoint para consultar métricas de campañas adicionando el parámetro **metrics\_summary=true**.

  

**Llamada:**

```javascript
curl -X  GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' https://api.mercadolibre.com/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/campaigns/search??limit=1&offset=0&date_from=2025-12-01&date_to=2025-12-30&metrics=clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,organic_units_amount,organic_items_quantity,direct_items_quantity,indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,direct_units_quantity,indirect_units_quantity,units_quantity,direct_amount,indirect_amount,total_amount&metrics_summary=true
```

**Respuesta:**

```javascript
{
    "paging": {
        "offset": 0,
        "total": 15,
        "limit": 1
    },
    "results": [
        {
            "id": 355189450,
            "name": "Campaña",
            "status": "active",
            "last_updated": "2025-11-25T21:12:59.000Z",
            "date_created": "2025-11-25T21:12:59.000Z",
            "strategy": "VISIBILITY",
            "acos_target": 50.0,
            "acos_top_search_target": 0.0,
            "roas_target": 2.0,
            "channel": "marketplace",
            "advertiser_id": 882927,
            "salesforce_event_id": 14,
            "budget": 900.0,
            "automatic_budget": false,
            "metrics": {
                "clicks": 0,
                "prints": 0,
                "cost": 0.0,
                "cpc": 0.0,
                "ctr": 0.0,
                "direct_amount": 0.0,
                "indirect_amount": 0.0,
                "total_amount": 0.0,
                "direct_units_quantity": 0,
                "indirect_units_quantity": 0,
                "units_quantity": 0,
                "direct_items_quantity": 0,
                "indirect_items_quantity": 0,
                "advertising_items_quantity": 0,
                "organic_units_quantity": 0,
                "organic_units_amount": 0.0,
                "organic_items_quantity": 0,
                "acos": 0.0,
                "cvr": 0.0,
                "roas": 0.0,
                "sov": 0.0
            }
        }
    ],
    "metrics_summary": {
        "clicks": 0,
        "prints": 0,
        "cost": 0.0,
        "cpc": 0.0,
        "ctr": 0.0,
        "direct_amount": 0.0,
        "indirect_amount": 0.0,
        "total_amount": 0.0,
        "direct_units_quantity": 0,
        "indirect_units_quantity": 0,
        "units_quantity": 0,
        "direct_items_quantity": 0,
        "indirect_items_quantity": 0,
        "advertising_items_quantity": 0,
        "organic_units_quantity": 0,
        "organic_units_amount": 0.0,
        "organic_items_quantity": 0,
        "acos": 0.0,
        "cvr": 0.0,
        "roas": 0.0,
        "sov": 0.0
    }
}
```

## Detalle y métricas de una campaña

**Parámetros opcionales:**

-   **date\_from:** fecha desde (YYYY-MM-DD). Se valida que esté presente si se solicitan campos metrics.
-   **date\_to:** fecha hasta (YYYY-MM-DD). Se valida que esté presente si se solicitan campos metrics.
-   **metrics:** lista separada por coma (Ej clicks,prints) indica los campos que serán retornados en la respuesta. Valores posibles:  
    clicks, prints, ctr, cost, cpc, acos, organic\_units\_quantity, organic\_units\_amount, organic\_items\_quantity, direct\_items\_quantity, indirect\_items\_quantity, advertising\_items\_quantity, cvr, roas, sov, direct\_units\_quantity, indirect\_units\_quantity, units\_quantity, direct\_amount, indirect\_amount, total\_amount, impression\_share, top\_impression\_share, lost\_impression\_share\_by\_budget, lost\_impression\_share\_by\_ad\_rank, acos\_benchmark.
-   **aggregation:** agregación por la cual se presentarán los resultados. Default: sum.
-   **aggregation\_type:** tipo de agregación en la cual se presentarán los resultados. Default: campaign.

**Llamada:**

```javascript
curl GET -H 'api-version: 2' -H 'Authorization: Bearer $ACCESS_TOKEN' https://api.mercadolibre.com/advertising/$ADVERTISER_SITE_ID/product_ads/campaigns/$CAMPAIGN_ID??date_from=2025-12-01&date_to=2025-12-30&metrics=clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,organic_units_amount,organic_items_quantity,direct_items_quantity,indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,direct_units_quantity,indirect_units_quantity,units_quantity,direct_amount,indirect_amount,total_amount,impression_share,top_impression_share,lost_impression_share_by_budget,lost_impression_share_by_ad_rank,acos_benchmark
```

**Respuesta:**

```javascript
{
    "id": 355189450,
    "name": "Campaña",
    "status": "active",
    "last_updated": "2025-11-25T21:12:59.000Z",
    "date_created": "2025-11-25T21:12:59.000Z",
    "strategy": "VISIBILITY",
    "acos_target": 50.0,
    "acos_top_search_target": 0.0,
    "roas_target": 2.0,
    "channel": "marketplace",
    "budget": 900.0,
    "currency_id": "ARS",
    "metrics": {
        "clicks": 0,
        "prints": 0,
        "cost": 0.0,
        "cpc": 0.0,
        "ctr": 0.0,
        "direct_amount": 0.0,
        "indirect_amount": 0.0,
        "total_amount": 0.0,
        "direct_units_quantity": 0,
        "indirect_units_quantity": 0,
        "units_quantity": 0,
        "direct_items_quantity": 0,
        "indirect_items_quantity": 0,
        "advertising_items_quantity": 0,
        "organic_units_quantity": 0,
        "organic_units_amount": 0.0,
        "organic_items_quantity": 0,
        "acos": 0.0,
        "cvr": 0.0,
        "roas": 0.0,
        "sov": 0.0,
        "impression_share": 0.0,
        "top_impression_share": 0.0,
        "lost_impression_share_by_budget": 0.0,
        "lost_impression_share_by_ad_rank": 0.0,
        "acos_benchmark": 0.0
    }
}
```

## Métricas diarias de una campaña

**Llamada:**

```javascript
curl -X  GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2'
https://api.mercadolibre.com/advertising/$ADVERTISER_SITE_ID/product_ads/campaigns/$CAMPAIGN_ID?date_from=2024-01-01&date_to=2024-02-28&metrics=clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,organic_units_amount,organic_items_quantity,direct_items_quantity,indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,direct_units_quantity,indirect_units_quantity,units_quantity,direct_amount,indirect_amount,total_amount,impression_share,top_impression_share,lost_impression_share_by_budget,lost_impression_share_by_ad_rank,acos_benchmark&aggregation_type=DAILY
```

**Respuesta:**

```javascript
[
   {
       "date": "2024-01-01",
       "clicks": 0,
       "prints": 0,
       "ctr": 0.01,
       "cost": 0.01,
       "cpc": 0.01,
       "acos": 0.01,
       "organic_units_quantity": 0,
       "organic_units_amount": 0,
       "organic_items_quantity": 0,
       "direct_items_quantity": 0,
       "indirect_items_quantity": 0,
       "advertising_items_quantity": 0,
       "cvr": 0,
       "roas": 0,
       "sov": 0,
       "direct_units_quantity": 0,
       "indirect_units_quantity": 0,
       "units_quantity": 0,
       "direct_amount": 0.01,
       "indirect_amount": 0.01,
       "total_amount": 0.01,
       "impression_share": 0,
       "top_impression_share": 0,
       "lost_impression_share_by_budget": 0.01,
       "lost_impression_share_by_ad_rank": 0.01,
       "acos_benchmark": 123      
   }
]
```

## Métricas de anuncios

**Parámetros opcionales:**

-   **limit:** límite de elementos a mostrar.
-   **offset:** atributo de paginado de los resultados, permite recorrer las páginas de la lista desde el 0 hasta el múltiplo del total de elementos con el límite por página.
-   **date\_from:** fecha desde (YYYY-MM-DD). Validamos que esté presente si se solicitan campos metrics.
-   **date\_to:** fecha hasta (YYYY-MM-DD). Validamos que esté presente si se solicitan campos metrics.
-   **metrics:** lista separada por coma (Ej clicks,prints) indica los campos que serán retornados en la respuesta. Valores posibles:  
    clicks, prints, cost, cpc, acos, organic\_units\_quantity, organic\_units\_amount, organic\_items\_quantity, direct\_items\_quantity, indirect\_items\_quantity, advertising\_items\_quantity, direct\_units\_quantity, indirect\_units\_quantity, units\_quantity, direct\_amount, indirect\_amount, total\_amount.
-   **sort:** ordenamiento de la consulta, asc y desc.
-   **sort\_by:** nombre del atributo por el cual se va a realizar el ordenamiento.
-   **aggregation:** agregación por la cual se presentarán los resultados. Default: sum.
-   **aggregation\_type:** tipo de agregación en la cual se presentarán los resultados: DAILY, item. Default: item.
-   **metrics\_summary:** sumariza las métricas y debes usarlo en combinación con metrics. Default false.

### Filtros disponibles

Para utilizar los filtros debes seguir la estructura **?filters\[nombre del filtro\]= valor**.

  

**item\_id**: Id del anuncio. Uno o más, separados por coma.

**statuses**: status de ads. Valores disponibles: active, paused, hold, idle, delegated, revoked por lo general se filtra por active, paused e idle.

-   **hold**: el item está deshabilitado en publicidad esto resultado de que el item a nivel marketplace está pausado o sin stock
-   **idle**: el item está disponible para tener publicidad pero no está en ninguna campaña de publicidad.
-   **delegated**: significa que de cara al owner que consulta el item está delegado a otro advertiser. Es decir, si bien el owner (seller) puede ser el dueño del ítem, ya no tiene potestad para operar sobre él porque están "prestados" a otro advertiser.
-   **revocado**: significa que de cara al advertiser al que le fueron prestado los items, este advertiser los devolvió al dueño por lo que ya no tiene potestad para operar sobre esos items.

**channel**: canal de venta 'marketplace' (Mercado Libre).

**price**: precio.

**buy\_box\_winner**: el ítem asociado es el ganador de Catálogo. Conoce más sobre [Competencia en Catálogo](/es_ar/competencia-en-catalogo#).

**condition**: condición del ítem asociado.

**current\_level**: reputación del ítem asociado.

**deferred\_stock**: stock del ítem asociado.

**domains**: dominio del ítem asociado.

**logistic\_types**: tipo de logística del ítem asociado.

**listing\_types**: tipo de listado del ítem asociado.

**official\_stores**: tienda oficial del ítem asociado.

**recommended**: el anuncio es recomendado por Product Ads. Según nuestros modelos, tiene buen rendimiento y si se le activa la publicidad, las ventas se verán potenciadas.

**campaign\_id**: obtén todos los anuncios que ha tenido una campaña en un período de tiempo.

**campaigns**: listado de campañas separados por coma.

**brand\_value\_id**: identificador de marca.

**brand\_value\_name**: nombre de la marca.

  

## Search y métricas de todos los anuncios

Obtén todos los anuncios y métricas correspondientes a estos.

  

**Llamada:**

```javascript
curl -X  GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' https://api.mercadolibre.com/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/ads/search?limit=1&offset=0&date_from=2024-01-01&date_to=2024-02-28&metrics=clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,organic_units_amount,organic_items_quantity,direct_items_quantity,indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,direct_units_quantity,indirect_units_quantity,units_quantity,direct_amount,indirect_amount,total_amount
```

**Ejemplo:**

```javascript
curl -X  GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' https://api.mercadolibre.com/advertising/MLM/advertisers/35300/product_ads/ads/search?limit=1&offset=0&date_from=2024-01-01&date_to=2024-02-28&metrics=clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,organic_units_amount,organic_items_quantity,direct_items_quantity,indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,direct_units_quantity,indirect_units_quantity,units_quantity,direct_amount,indirect_amount,total_amount
```

**Respuesta:**

```javascript
{
   "paging": {
       "offset": 0,
       "last_item_id": null,
       "total": 387,
       "limit": 1
   },
   "results": [
       {
           "item_id": "MLM12345678",
           "campaign_id": 0,
           "price": 16999.0,
           "title": "Pantalla Samsung Led Smart Tv De 65 Pulgadas 4k/uhd",
           "status": "active",
           "has_discount": false,
           "catalog_listing": true,
           "logistic_type": "default",
           "listing_type_id": "gold_pro",
           "domain_id": "MLM-TELEVISIONS",
           "date_created": "2024-03-15T14:41:47Z",
           "buy_box_winner": false,
           "tags": [],
           "channel": "marketplace",
           "official_store_id": 111,
           "brand_value_id": "222",
           "brand_value_name": "Marca",
           "condition": "new",
           "current_level": "unknown",
           "deferred_stock": false,
           "picture_id": "ABCD_12345_XS",
           "thumbnail": "http://http2.mlstatic.com/D_870627-MLA111111_022024-I.jpg",
           "permalink": "https://articulo.mercadolibre.com.mx/MLM-12345678-pulgadas-4kuhd-_JM",
           "recommended": false,
           "metrics": {
               "clicks": 0,
               "prints": 0,
               "cost": 0.01,
               "cpc": 0.01,
               "acos": 0.01,
               "organic_units_quantity": 0,
               "organic_items_quantity": 0,
               "direct_items_quantity": 0,
               "indirect_items_quantity": 0,
               "advertising_items_quantity": 0,
               "direct_units_quantity": 0,
               "indirect_units_quantity": 0,
               "units_quantity": 0,
               "direct_amount": 0.01,
               "indirect_amount": 0.01,
               "total_amount": 0.01
           }
       }
   ]
}
```

## Métricas diarias de anuncios

**Llamada:**

```javascript
curl -X  GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' https://api.mercadolibre.com/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/ads/search?limit=1&offset=0&date_from=2024-01-01&date_to=2024-02-28&metrics=clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,organic_units_amount,organic_items_quantity,direct_items_quantity,indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,direct_units_quantity,indirect_units_quantity,units_quantity,direct_amount,indirect_amount,total_amount&aggregation_type=DAILY
```

**Respuesta:**

```javascript
{
   "paging": {
       "offset": 0,
       "last_item_id": null,
       "total": 387,
       "limit": 1
   },
   "results": [
       {
           "date": "2023-01-01",
           "clicks": 0,
           "prints": 0,
           "cost": 0.01,
           "cpc": 0.01,
           "acos": 0.01,
           "organic_units_quantity": 0,
           "organic_items_quantity": 0,
           "direct_items_quantity": 0,
           "indirect_items_quantity": 0,
           "advertising_items_quantity": 0,
           "direct_units_quantity": 0,
           "indirect_units_quantity": 0,
           "units_quantity": 0,
           "direct_amount": 0.01,
           "indirect_amount": 0.01,
           "total_amount": 0.01
       }
   ]
}
```

## Métricas sumarizada de anuncios

**Llamada:**

```javascript
curl -X  GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' https://api.mercadolibre.com/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/ads/search?limit=1&offset=0&date_from=2024-01-01&date_to=2024-02-28&metrics=clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,organic_units_amount,organic_items_quantity,direct_items_quantity,indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,direct_units_quantity,indirect_units_quantity,units_quantity,direct_amount,indirect_amount,total_amount&metrics_summary=true
```

**Respuesta:**

```javascript
{
   "paging": {
       "offset": 0,
       "last_item_id": null,
       "total": 387,
       "limit": 1
   },
   "results": [
       {
           "item_id": "MLM2945612374",
           "campaign_id": 0,
           "price": 16999.0,
           "title": "Pantalla Samsung Led Smart Tv De 65 Pulgadas 4k/uhd",
           "status": "delegated",
           "has_discount": false,
           "catalog_listing": true,
           "logistic_type": "default",
           "listing_type_id": "gold_pro",
           "domain_id": "MLM-TELEVISIONS",
           "date_created": "2024-03-15T14:41:47Z",
           "buy_box_winner": false,
           "tags": [],
           "channel": "marketplace",
           "official_store_id": 111,
           "brand_value_id": "222",
           "brand_value_name": "Marca",
           "condition": "new",
           "current_level": "unknown",
           "deferred_stock": false,
           "picture_id": "ABCD_12345_XS",
           "thumbnail": "http://http2.mlstatic.com/D_870627-MLA74798069591_022024-I.jpg",
           "permalink": "https://articulo.mercadolibre.com.mx/MLM-2945696974-pantalla-samsung-led-smart-tv-de-65-pulgadas-4kuhd-_JM",
           "recommended": false,
           "metrics": {
               "clicks": 0,
               "prints": 0,
               "cost": 0.01,
               "cpc": 0.01,
               "acos": 0.01,
               "organic_units_quantity": 0,
               "organic_items_quantity": 0,
               "direct_items_quantity": 0,
               "indirect_items_quantity": 0,
               "advertising_items_quantity": 0,
               "direct_units_quantity": 0,
               "indirect_units_quantity": 0,
               "units_quantity": 0,
               "direct_amount": 0.01,
               "indirect_amount": 0.01,
               "total_amount": 0.01
             }
       }
   ],
   "metrics_summary": {
       "clicks": 0,
       "prints": 0,
       "ctr": 0.01,
       "cost": 0.01,
       "cpc": 0.01,
       "acos": 0.01,
       "organic_units_quantity": 0,
       "organic_units_amount": 0,
       "organic_items_quantity": 0,
       "direct_items_quantity": 0,
       "indirect_items_quantity": 0,
       "advertising_items_quantity": 0,
       "cvr": 0,
       "roas": 0,
       "sov": 0,
       "direct_units_quantity": 0,
       "indirect_units_quantity": 0,
       "units_quantity": 0,
       "direct_amount": 0.01,
       "indirect_amount": 0.01,
       "total_amount": 0.01
   }
}
```

## Métricas de un anuncio

**Parámetros opcionales:**

-   **date\_from:** fecha desde (YYYY-MM-DD). Validamos que esté presente si se solicitan campos metrics.
-   **date\_to:** fecha hasta (YYYY-MM-DD). Validamos que esté presente si se solicitan campos metrics.
-   **metrics:** lista separada por coma (Ej clicks, prints). Indica los campos que serán retornados en la respuesta. Valores posibles:  
    clicks, prints, ctr, cost, cpc, acos, organic\_units\_quantity, organic\_units\_amount, organic\_items\_quantity, direct\_items\_quantity, indirect\_items\_quantity, advertising\_items\_quantity, cvr, roas, sov, direct\_units\_quantity, indirect\_units\_quantity, units\_quantity, direct\_amount, indirect\_amount, total\_amount.
-   **aggregation:** agregación por la cual se presentarán los resultados. Default: sum.
-   **aggregation\_type:** tipo de agregación en la cual se presentarán los resultados: DAILY, item. Default: item.
-   **channel:** canal del ítem; marketplace.

**Llamada:**

```javascript
curl -X  GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' https://api.mercadolibre.com/advertising/$ADVERTISER_SITE_ID/product_ads/ads/$ITEM_ID?date_from=2024-01-01&date_to=2024-02-28&metrics=clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,organic_units_amount,organic_items_quantity,direct_items_quantity,indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,direct_units_quantity,indirect_units_quantity,units_quantity,direct_amount,indirect_amount,total_amount
```

**Respuesta:**

```javascript
{
  "item_id": "MLM2945612374", 
  "campaign_id": 0,
  "price": 16999.0,
  "title": "Pantalla Samsung Led Smart Tv De 65 Pulgadas 4k/uhd",
  "status": "X",
  "has_discount": false,
  "catalog_listing": true,
  "logistic_type": "default",
  "listing_type_id": "gold_pro",
  "domain_id": "MLM-TELEVISIONS",
  "date_created": "2024-03-15T14:41:47Z",
  "buy_box_winner": false,
  "tags": [],
  "channel": "marketplace",
  "official_store_id": 111,
  "brand_value_id": "222",
  "brand_value_name": "Marca",
  "condition": "new",
  "current_level": "unknown",
  "deferred_stock": false,
  "picture_id": "ABCD_12345_XS",
  "thumbnail": "http://http2.mlstatic.com/D_870627-MLA74798069591_022024-I.jpg",
  "permalink": "https://articulo.mercadolibre.com.mx/MLM-2945696974-pantalla-samsung-led-smart-tv-de-65-pulgadas-4kuhd-_JM",
  "recommended": false,  
  "metrics_summary": {
       "clicks": 0,
       "prints": 0,
       "cost": 0.01,
       "cpc": 0.01,
       "acos": 0.01,
       "organic_units_quantity": 0,
       "organic_items_quantity": 0,
       "direct_items_quantity": 0,
       "indirect_items_quantity": 0,
       "advertising_items_quantity": 0,
       "direct_units_quantity": 0,
       "indirect_units_quantity": 0,
       "units_quantity": 0,
       "direct_amount": 0.01,
       "indirect_amount": 0.01,
       "total_amount": 0.01
   }
}
```

## Métricas diarias de un anuncio

**Llamada:**

```javascript
curl -X  GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' https://api.mercadolibre.com/advertising/$ADVERTISER_SITE_ID/product_ads/ads/$ITEM_ID?date_from=2024-01-01&date_to=2024-02-28&metrics=clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,organic_units_amount,organic_items_quantity,direct_items_quantity,indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,direct_units_quantity,indirect_units_quantity,units_quantity,direct_amount,indirect_amount,total_amount&aggregation_type=DAILY
```

**Respuesta:**

```javascript
{
   "results": [
       {
           "date": "2023-01-01",
           "clicks": 0,
           "prints": 0,
           "ctr": 0.01,
           "cost": 0.01,
           "cpc": 0.01,
           "acos": 0.01,
           "organic_units_quantity": 0,
           "organic_units_amount": 0,
           "organic_items_quantity": 0,
           "direct_items_quantity": 0,
           "indirect_items_quantity": 0,
           "advertising_items_quantity": 0,
           "cvr": 0,
           "roas": 0,
           "sov": 0,
           "direct_units_quantity": 0,
           "indirect_units_quantity": 0,
           "units_quantity": 0,
           "direct_amount": 0.01,
           "indirect_amount": 0.01,
           "total_amount": 0.01   
       }
   ]
}
```

## Glosario

**advertiser\_site\_id**:sitio del advertiser.

**total**: total de registros obtenidos.

**offset**: valor por defecto: 0.

**limit**: límites de elementos en la lista de campañas. Por defecto: 50.

**results**: resultados obtenidos.

**id**: identificador del anuncio o campaña.

**budget**: promedio diario del presupuesto (mensual) de la campaña, es decir, si el presupuesto no queda consumido durante el día se usará el restante en los días siguientes hasta que finalice el mes.

**last\_updated**: fecha de última modificación de la campaña.

**date\_created**: fecha de creación de la campaña.

**price**: precio del artículo asociado.

**title**: nombre de la publicación.

**has\_discount**: si cuenta con descuento. Este valor se identifica en base a la diferencia entre los campos regular amount y amount entregado por [Prices API](/es_ar/api-de-precios#Obtener-precio-de-venta-actual).

**catalog\_listing**: es una publicación de catálogo.

**logistic\_type**: tipo de logística para el envío del artículo.

**listing\_type\_id**: identificador del tipo de publicación.

**domain\_id**: dominio.

**date\_created**: fecha de creación del anuncio.

**official\_store\_id**: identificador de la tienda oficial.

**buy\_box\_winner**: es ganador de Catálogo.

**channel**: canal de la campaña (marketplace).

**campaign\_id**: identificador de la campaña.

**condition**: condición del artículo.

**current\_level**: reputación.

**deferred\_stock**: stock de producto disponible. Un [item con manufacturing\_time](/es_ar/producto-sincroniza-modifica-publicaciones#Agregar-tiempo-de-disponibilidad-de-stock) (tiempo de disponibilidad) hace que el anuncio no se muestre, se priorizan entonces los anuncios que tengan stock inmediato.

**thumbnail**: enlace a la imagen miniatura.

**permalink**: enlace a la publicación.

**brand\_value\_id**: identificador de la marca asociada al ítem.

**brand\_value\_name**: nombre de la marca asociada al ítem.

**status**: estado del anuncio o campaña.

**recommended**: el anuncio es recomendado.

**metrics**: métricas del artículo o campaña.

**clicks**: clicks de la campaña.

**prints**: cantidad de impresiones (veces en las que se muestra el anuncio).

**sov**: porcentaje de ventas por publicidad sobre ventas totales.

**clicks**: clicks de la campaña.

**ctr**: tasa de clicks.

**cost**: inversión de la campaña.

**cpc**: costo por click.

**acos**: porcentaje de inversión en publicidad sobre los ingresos obtenidos.

  

**Ventas sin publicidad**

-   **organic\_units\_quantity**: cantidad de unidades vendidas sin publicidad.
-   **organic\_units\_amount**: monto de ventas de órdenes orgánicas.
-   **organic\_items\_quantity**: cantidad de ventas sin publicidad.

  

**Ventas con publicidad**

-   **Ventas directas**

-   **direct\_items\_quantity**: cantidad de ventas directas por publicidad.
-   **direct\_units\_quantity**: cantidad de unidades vendidas en ventas directas.
-   **direct\_amount**: suma del valor de las ventas directas obtenidas de tu Product Ad, en moneda local.

-   **Ventas indirectas**

-   **indirect\_items\_quantity**: cantidad de ventas indirectas por publicidad.
-   **indirect\_units\_quantity**: cantidad de unidades vendidas en ventas asistidas.
-   **indirect\_amount**: suma del valor de las ventas asistidas obtenidas de tu Product Ad, en moneda local.

**advertising\_items\_quantity**: cantidad de ventas por publicidad.  
**cvr**: tasa de conversión.  
**roas**: retorno sobre el gasto publicitario.  
**units\_quantity**: cantidad de ventas totales.  
**total\_amount**: suma del valor de las ventas obtenidas de tu Product Ad, en moneda local.  
**impression\_share**: porcentaje de veces que se muestran los anuncios considerando todas las veces que pueden ser mostrados.  
**top\_impression\_share**: cantidad de subastas ganadas en las primeras posiciones del search entre la cantidad de subastas en las que pudo participar.  
**lost\_impression\_share\_by\_budget**: porcentaje de veces que no se muestran los anuncios considerando todas las veces que pudieran ser mostrados y que no sucedió porque el presupuesto es muy bajo.  
**lost\_impression\_share\_by\_ad\_rank**: porcentaje de veces que no se muestran los anuncios considerando todas las veces que pueden ser mostrados y que no sucedió porque tu rango es más bajo que otros vendedores.  
**acos\_benchmark**: el ACOS objetivo usado por anuncios con buenos resultados en impresiones y ventas.  
**picture\_id**: id de imagen del artículo a nivel MercadoLibre.  
**acos\_target**: costo publicitario de ventas (ACOS) target utilizado por anuncios con buenos resultados en impresiones y ventas.  
**strategy**: tipo de estrategia de campaña. Puede ser PROFITABILITY, INCREASE y VISIBILITY.  
**roas\_target**: Retorno sobre la inversión publicitaria (ROAS Objetivo). Es la receta generada por la campaña/anuncio por cada unidad monetaria invertida en publicidad (ingresos atribuibles /gasto publicitario). Debe ser mayor o igual a 1x e inferior o igual a 35x.  
  

**¿Cómo interpreto la relación entre el ROAS que defino y mis resultados?**

  

**ROAS Objetivo bajo:** Busca generar más ventas y tener mayor alcance, aunque la rentabilidad por cada venta sea menor.

  

**ROAS Objetivo alto:** Busca mayor rentabilidad por cada venta, aunque esto signifique que sus anuncios sean menos competitivos y generen un volumen de ventas e ingresos totales más bajo.

  

Contenidos

-   [
    
    Product Ads
    
    
    
    ](#)
-   [
    
    Consultar anunciante
    
    
    
    ](#Consultar-anunciante)
-   [
    
    Detalle de un anuncio
    
    
    
    ](#Detalle-de-un-anuncio)
-   [
    
    Métricas de campañas
    
    
    
    ](#Métricas-de-campañas)
-   [
    
    Search y métricas de campañas
    
    
    
    ](#Search-y-métricas-de-campañas)
-   [
    
    Métricas diarias de campañas
    
    
    
    ](#Métricas-diarias-de-campañas)
-   [
    
    Métricas sumarizadas de campañas
    
    
    
    ](#Métricas-sumarizadas-de-campañas)
-   [
    
    Detalle y métricas de una campaña
    
    
    
    ](#Detalle-y-métricas-de-una-campaña)
-   [
    
    Métricas diarias de una campaña
    
    
    
    ](#Métricas-diarias-de-una-campaña)
-   [
    
    Métricas de anuncios
    
    
    
    ](#Métricas-de-anuncios)
-   [
    
    Search y métricas de todos los anuncios
    
    
    
    ](#Search-y-métricas-de-todos-los-anuncios)
-   [
    
    Métricas diarias de anuncios
    
    
    
    ](#Métricas-diarias-de-anuncios)
-   [
    
    Métricas sumarizada de anuncios
    
    
    
    ](#Métricas-sumarizada-de-anuncios)
-   [
    
    Métricas de un anuncio
    
    
    
    ](#Métricas-de-un-anuncio)
-   [
    
    Métricas diarias de un anuncio
    
    
    
    ](#Métricas-diarias-de-un-anuncio)
-   [
    
    Glosario
    
    
    
    ](#glosario)

[](#)