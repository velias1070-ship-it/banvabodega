---
source_url: https://global-selling.mercadolibre.com/devsite/gs-billing-data
title: "Developers"
selector: "main"
synced_at: 2026-04-13T12:20:47.632Z
---

Documentation Mercado Libre

Check out all the necessary information about APIs Mercado Libre.

![circulos azuis em degrade](https://http2.mlstatic.com/storage/developers-site-cms-admin/DevImgs/230801158836-ImgMS--1-.png)

Documentation

Last update 15/12/2025

## Billing Data

To bill a sale, you need to obtain the buyer's tax data through the API **/orders/order\_id/billing\_info**

  

## Query billing data

Get the buyer's tax data for invoice issuance.

**Request:**

```javascript
curl -X GET \
  -H 'Authorization: Bearer $ACCESS_TOKEN' \ https://api.mercadolibre.com/marketplace/orders/$ORDER_ID/billing_info
```

**Example:**

```javascript
curl -X GET \
  -H 'Authorization: Bearer $ACCESS_TOKEN' \ https://api.mercadolibre.com/marketplace/orders/4469851203/billing_info
```

## Response with examples for individuals and legal entities

**MLA - Individual**

```javascript

  {
    "site_id":"MLA",
    "buyer":{
      "cust_id": 123123123,
      "billing_info":{
        "name":"Juan Soares",
        "last_name":"Sanchez",
        "identification":{
            "type":"DNI" / "CUIL",
            "number":"307722738"
        },
        "taxes": {
          "taxpayer_type": {
              "id": "01",
              "description": "Final Consumer"
          }
        },
        "address":{
            "street_name":"Aysen",
            "street_number":"30",
            "city_name":"Buenos Aires",
            "state":{
              "code": "01",
              "name": "Buenos Aires"
          },
            "zip_code":"5000",
            "country_id":"AR"
        },
        "attributes": {
          "vat_discriminated_billing": "true",
          "doc_type_number": "123123123",
          "is_normalized": true,
          "cust_type": "CO"
        }
      }
    },
    "seller":{
        "cust_id": 0,
    }
  }
```

**  
MLA - Legal Entity**  

```javascript

  {
    "site_id":"MLA",
    "buyer":{
      "cust_id": 123123123,
      "billing_info":{
        "name":"Apple Argentina"
        "identification":{
            "type":"CUIT",
            "number":"307722738"
        },
        "taxes": {
          "taxpayer_type": {
              "description": "VAT Registered Taxpayer"
          }
        },
        "address":{
            "street_name":"Aysen",
            "street_number":"30",
            "city_name":"Buenos Aires",
            "state":{
              "code": "01",
              "name": "Buenos Aires"
          },
            "zip_code":"5000",
            "country_id":"AR"
        },
        "attributes": {
          "vat_discriminated_billing": "true",
          "doc_type_number": "123123123",
          "is_normalized": true,
          "cust_type": "BU"
        }
      }
    },
    "seller":{
        "cust_id": 0,
    }
  }
```

**  
MLB - Individual**  

```javascript

  {
    "site_id": "MLB",
    "buyer": {
      "cust_id": 234343545,
      "billing_info": {
        "name": "María Lupita",
        "last_name": "Gomez Blanco",
        "identification": {
          "type": "CPF",
          "number": "32659430" 
        },
        "address": {
          "street_name": "Nicolau de Marcos",
          "street_number": "05",
          "city_name": "Bom Jardim",
          "comment": "7b",
          "neighborhood": "Jardim Ornelas",
          "state": {
            "name": "Rio de Janeiro"
          },
          "zip_code": "28660000",
          "country_id": "BR"
        },
        "attributes": {
            "is_normalized": true,
            "cust_type": "CO"
        }
      }
    },
    "seller": {
      "cust_id": 34345454,
    }
  }
```

**  
MLB - Legal Entity**  

```javascript

  {
    "site_id": "MLB",
    "buyer": {
      "cust_id": 234343545,
      "billing_info": {
        "name": "Apple Brasil",
    "identification": {
          "type": "CNPJ",
          "number": "326594309119203" 
        },
        "taxes": {
          "inscriptions": 
          {
              "state_registration": "30703088534",
          }
          , 
          "taxpayer_type": {
            "description": "Taxpayer" 
          }
        },
        "address": {
          "street_name": "Nicolau de Marcos",
          "street_number": "05",
          "city_name": "Bom Jardim",
          "comment": "7b",
          "neighborhood": "Jardim Ornelas",
          "state": {
            "name": "Rio de Janeiro"
          },
          "zip_code": "28660000",
          "country_id": "BR"
        },
        "attributes": {
            "is_normalized": true,
            "cust_type": "BU"
        }
      }
    },
    "seller": {
      "cust_id": 34345454,
    }
  }
```

**  
MLM - Individual**  

```javascript

  {
    "site_id": "MLM",
    "buyer": {
      "cust_id": 234343545,
      "billing_info": {
        "name": "Juan Soraes",
        "last_name": "Sanchez",	
        "identification": {
          "type": "RFC",
          "number": "CUPU800825569"
        },
        "taxes": {
          "contributor": "INDIVIDUAL",
          "taxpayer_type": {
            "id": "606",
            "description": "Leasing"
          },
          "cfdi": {
            "id": "G03",
            "description": "General expenses"
          }
        },
        "address": {
          "street_name": "Calle 134A #18A",
          "street_number": "05",
          "city_name": "Alvaro Obregón",
          "state": {
            "code": "DIF",
            "name": "Distrito Federal"
          },
          "zip_code": "01040",
          "country_id": "MX"
        },
        "attributes": {
          "vat_discriminated_billing": "true",
          "birth_date": "2000/02/03",
          "is_normalized": true,
          "customer_type": "CO"
        }
      }
    },
    "seller": {
      "cust_id": 34345454
    }
  }
```

**  
MLM - Legal Entity**  

```javascript

  {
    "site_id": "MLM",
    "buyer": {
      "cust_id": 234343545,
      "billing_info": {
        "name": "SALVADO HNOS S A",
        "identification": {
          "type": "RFC",
          "number": "CUPU800825569"
        },
        "taxes": {
          "contributor": "LEGAL ENTITY",
          "taxpayer_type": {
            "id": "606",
            "description": "Leasing"
          },
          "cfdi": {
            "id": "G03",
            "description": "General expenses"
          }
        },
        "address": {
          "street_name": "Calle 134A #18A",
          "street_number": "05",
          "city_name": "Alvaro Obregón",
          "state": {
            "code": "DIF",
            "name": "Distrito Federal"
          },
          "zip_code": "01040",
          "country_id": "MX"
        },
        "attributes": {
          "vat_discriminated_billing": "true",
          "birth_date": "2000/02/03",
          "is_normalized": true,
          "customer_type": "BU"
        }
      }
    },
    "seller": {
      "cust_id": 34345454,
    }
  }
```

**Note:**

-   When the buyer's billing data indicates the generic RFC XAXX010101000, it means that the buyer did not request a nominal invoice. In this case, the seller will have the freedom to decide whether to issue a generic invoice or a global invoice.

**  
MLC - Individual**  

```javascript

  {
    "site_id": "MLC",
    "buyer": {
      "cust_id": 234343545,
      "billing_info": {
        "name": "Tamara nicolt",
        "last_name": "larenas reyes",
        "identification": {
          "type": "RUT",
          "number": "159321126"
        },
     "address": {
          "street_name": "Pasaje Beethoven",
          "street_number": "56",
          "city_name": "Maipú",
          "comment": "73",
          "neighborhood": "Maipú",
          "state": {
            "name": "RM (Metropolitana)"
          },
          "country_id": "CL"
        },
        "attributes": {
          "is_normalized": true,
           "cust_type": "CO"
       }
      }
    },
    "seller": {
      "cust_id": 34345454,
    }
  }
```

**  
MLC - Legal Entity**  

```javascript

  {
    "site_id": "MLC",
    "buyer": {
      "cust_id": 234343545,
      "billing_info": {
        "name": "Apple",
        "identification": {
          "type": "RUT",
          "number": "159321126"
        },
        "taxes": {
           "economic_activity": "Sale and rental of electronic articles",
        },
        "address": {
          "street_name": "Pasaje Beethoven",
          "street_number": "56",
          "city_name": "Maipú",
          "comment": "73",
          "neighborhood": "Maipú",
          "state": {
            "name": "RM (Metropolitana)"
          },
          "country_id": "CL"
        },
        "attributes": {
          "is_normalized": true,
      "cust_type": "BU" 
       }
      }
    },
    "seller": {
      "cust_id": 34345454,
    }
  }
```

**  
MCO - Individual**  

```javascript

  {
    "site_id": "MCO",
    "buyer": {
      "cust_id": 234343545,
      "billing_info": {
        "name": "Adrian",
        "last_name": "Garces",
        "identification": {
          "type": "CC",
          "number": "73160000"
        },
      "address": {
            "street_name": "Pasaje Beethoven",
            "street_number": "#10-11",
            "city_name": "La Candelaria",
            "comment": "73",
            "neighborhood": "Candelaria",
            "state": {
              "name": "RM (Metropolitana)",
        "code": "CO-DC"
            },
            "country_id": "CO"
          },
      },
    "seller": {
      "cust_id": 34345454,
      }
    }
  }
```

**  
MCO - Legal Entity**  

```javascript

  {
    "site_id": "MCO",
    "buyer": {
      "cust_id": 234343545,
      "billing_info": {
        "name": "Apple",
        "identification": {
          "type": "CC",
          "number": "73160000"
        },
        "address": {
          "street_name": "Pasaje Beethoven",
          "street_number": "#10-11",
          "city_name": "La Candelaria",
          "comment": "73",
          "neighborhood": "Candelaria",
          "state": {
            "name": "RM (Metropolitana)",
            "code": "CO-DC"
          },
          "country_id": "CO"
        },
        "attributes": {
          "is_normalized": true
        }
      }
    },
    "seller": {
      "cust_id": 34345454,
    }
  }
```

## API Field Descriptions

**Individual**

-   **site\_id**: Site ID
-   **buyer**:
    -   **cust\_id**: Buyer ID
-   **billing\_info**:
    -   **name**: Buyer's first name
    -   **last\_name**: Buyer's last name
    -   **identification**:
        -   **type**: Document type
        -   **number**: Document number
-   **taxes**:
    -   **inscriptions**:
        -   **state\_registration**: State registration
    -   **economic\_activity**: Economic activity
    -   **contributor**: Taxpayer type
    -   **taxpayer\_type**:
        -   **id**: Entity identifier
        -   **description**: Buyer's tax status
-   **address**:
    -   **street\_name**: Buyer's street name
    -   **street\_number**: Buyer's address number
    -   **city\_name**: Buyer's city
    -   **neighborhood**: Buyer's neighborhood
    -   **zip\_code**: Buyer's postal code
    -   **comment**: Additional information about the buyer's address
-   **country\_id**: Country ID
-   **state**:
    -   **code**: State code
    -   **name**: State name
-   **secondary\_doc\_type**: Additional document type (MLA only)
-   **secondary\_doc\_number**: Additional document number (MLA only)
-   **attributes**:
    -   **birth\_date**: Buyer's birth date
    -   **doc\_type\_number**: Buyer's document number
    -   **cust\_type**: Legal entity or individual
-   **seller**:
    -   **cust\_id**: Seller ID

**The values CO or BU, when present in the `cust_type` field, mean:**

CO: Customer (Individual)  
BU: Business (Legal Entity)

**Legal Entity**

-   **business\_name**: Name of the buying legal entity
-   **taxpayer\_type\_id**: Legal entity's VAT status

**For MLA:**

-   Monotributo (Simplified Tax Regime)
-   VAT Registered Taxpayer
-   VAT Exempt

**For MLB:**

-   Taxpayer
-   Non-taxpayer

-   **state\_registration**: State registration
-   **doc\_type**: Document type
-   **doc\_number**: Document number
-   **zip\_code**: Buyer's postal code

-   **street\_name**: Buyer's billing address street name
-   **street\_number**: Buyer's billing address street number

**Possible values:** text, or "SN" for addresses without a number

-   **comment**: Additional information for the buyer's billing address
-   **state\_name**: State of the buyer's billing address
-   **city\_name**: City of the buyer's billing address

**DOC\_TYPE's:**

-   **Brazil (MLB):**
    -   **Individual:** CPF, RG
    -   **Legal Entity:** CNPJ
-   **Argentina (MLA):**
    -   **Individual:** DNI, CUIL
    -   **Legal Entity:** CUIT
-   **Chile (MLC):**
    -   **Individual:** RUT
    -   **Legal Entity:** RUT
-   **Colombia (MCO):**
    -   **Individual:** CC, CE
    -   **Legal Entity:** NIT
-   **Mexico (MLM):**
    -   **Individual:** RFC, CURP
    -   **Legal Entity:** RFC

Contents

-   [
    
    Billing Data
    
    
    
    ](#Billing-Data)
-   [
    
    Query billing data
    
    
    
    ](#Query-billing-data)
-   [
    
    Response with examples for individuals and legal entities
    
    
    
    ](#response-examples)
-   [
    
    API Field Descriptions
    
    
    
    ](#API-field-descriptions)

[](#)