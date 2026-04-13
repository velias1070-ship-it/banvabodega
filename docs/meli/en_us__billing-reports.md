---
source_url: https://developers.mercadolibre.com.ar/en_us/billing-reports
title: "Developers"
selector: "main"
synced_at: 2026-04-13T12:20:43.593Z
---

Documentation Mercado Libre

Check out all the necessary information about APIs Mercado Libre.

![circulos azuis em degrade](https://http2.mlstatic.com/storage/developers-site-cms-admin/DevImgs/230801158836-ImgMS--1-.png)

Documentation

Last update 04/02/2026

## Billing Reports

With this functionality, you can provide billing details made on Mercado Libre and Mercado Pago to sellers. By querying **/billing/monthly/periods** you will get information from the last 12 periods. Then, with **/documents** you can get all invoices (documents) for a period, and finally, with **/summary** and **/details** you can access the billing summary for a period and the respective details.  
  

**All endpoints require the group parameter**. Billing groups to obtain information: **ML** (Mercado Libre) or **MP** (Mercado Pago). If not specified, you will get information from both.

  

## Get period

Querying this endpoint first is optional, as the key needed to consume the rest of the endpoints is provided on the first day of the month. For example: `2023-06-01`. It allows you to get information about billing periods for the indicated billing group (Mercado Libre or Mercado Pago). By default, you receive the last 6 periods, with the possibility of querying older periods using offset and limit pagination. Maximum value: 12. Consider that the billing period may vary depending on the user.

  

### Required parameter

**document\_type**: type of document to obtain. Possible values: **BILL**; **CREDIT\_NOTE**.

  

**Call:**

```javascript
curl -X GET -H 'Authorization: Bearer $ACCESS_TOKEN' 
https://api.mercadolibre.com/billing/integration/monthly/periods
```

**Example:**

```javascript
curl -X GET -H 'Authorization: Bearer $ACCESS_TOKEN' 
https://api.mercadolibre.com/billing/integration/monthly/periods?group=MP&document_type=BILL&offset=1&limit=2
```

**Response:**

```javascript
{
  "offset": 1,
  "limit": 2,
  "total": 27,
  "results": [{
    "amount": 30.46000027656555,
    "unpaid_amount": 0.0,
    "period": {
      "date_from": "2020-02-19",
      "date_to": "2020-03-18"
    },
    "key": "2020-03-01",
    "expiration_date": "2020-03-24",
    "debt_expiration_date": "2020-03-24",
    "debt_expiration_date_move_reason": null,
    "debt_expiration_date_move_reason_description": null,
    "period_status": "CLOSED"
  }]
}
```

### Response parameters

-   **amount**: total value of the period.
-   **unpaid\_amount**: total amount pending payment.
-   **period**: date range of the period.
    -   date\_from: period start date.
    -   date\_to: period end date.
-   **key**: is the date of the first day of the month. For sites MLA, MLB, MCO, MLC, MLU, MPE, MLV, and MCR, this is the value used to consume the documents, details, and summary endpoints.
-   **expiration\_date**: period end date. It is always reported when the period status is closed. For MLM, this is the value used to consume the documents, details, and summary endpoints.
-   **debt\_expiration\_date**: debt expiration date. If the expiration date is not moved, this field will be equal to **expiration\_date**.
-   **debt\_expiration\_date\_move\_reason**: reason for the debt expiration date change. If the expiration date is not moved, this field will be null.

-   Possible values: **AUTOMATIC\_DOCUMENT\_CLOSURE\_PROCES**; **RECEIPT\_ANNULMENT\_PROCESS\_UNRECORDED**; **RECEIPT\_ANNULMENT\_PROCESS**; **PERIOD\_EXTENDED\_BY\_ADMIN**; **PAYMENT\_ANNULMENT**.

-   **debt\_expiration\_date\_move\_reason\_description**: internationalized description of debt\_expiration\_date\_move\_reason. If the expiration date is not moved, this field will be null.
-   **period\_status**: indicates whether the period is open or closed.
    -   Possible values: **OPEN**; **CLOSED**.

  

## Get Documents for a Period

Allows you to obtain information about documents (Invoices and Credit Notes) for a specific billing period for the indicated billing group (Mercado Libre or Mercado Pago).

  

### Optional parameters

-   **document\_id**: search by invoice id. E.g.: document\_id=987046992.
-   **document\_type**: filter by document type: Invoice or Credit Note. Possible values: **BILL**, **CREDIT\_NOTE**.
-   **offset**: allows searching from a result number. E.g.: offset=100 (returns from result number 100).
-   **limit**: limits the number of results. By default, the minimum is 150. Maximum allowed value: 1000. E.g.: limit=300 (returns up to 300 results).

**Call:**

```javascript
curl -X GET -H 'Authorization: Bearer $ACCESS_TOKEN'
https://api.mercadolibre.com/billing/integration/periods/key/$KEY/documents
```

**Example:**

```javascript
curl -X GET -H 'Authorization: Bearer $ACCESS_TOKEN'
https://api.mercadolibre.com/billing/integration/periods/key/2021-06-01/documents?group=MP&document_type=BILL&limit=1
```

**Response:**

```javascript
{
  "offset": 0,
  "limit": 1,
  "total": 2,
  "results": [{
    "id": 987654321,
    "user_id": 1234,
    "document_type": "BILL",
    "expiration_date": "2021-06-02",
    "associated_document_id": null,
    "amount": 3.86,
    "unpaid_amount": 0.0,
    "document_status": "BILLED",
    "site_id": "MLM",
    "period": {
      "date_from": "2021-05-03",
      "date_to": "2021-05-03"
    },
    "currency_id": "MXN",
    "count_details": 1,
    "files": [
      {
        "file_id": "1234_FE_MEPF00869625_pdf",
        "reference_number": "MEPF00999999"
      },
      {
        "file_id": "1234_FE_MEPF00869625_xml",
        "reference_number": "MEPF00999999"
      }
    ]
  }]
}
```

  

## Billing Summary

Allows you to obtain the summary of charges and bonuses that the seller had for a specific time period.

Important:

We do not recommend using this endpoint within batch processing. Its use is recommended sequentially. The information this endpoint provides does not change during the day, therefore one daily consumption per user is sufficient.

**Call:**

```javascript
curl -X GET -H 'Authorization: Bearer $ACCESS_TOKEN' 
https://api.mercadolibre.com/billing/integration/periods/key/$KEY/summary/details
```

**Example:**

```javascript
curl -X GET -H 'Authorization: Bearer $ACCESS_TOKEN' 
https://api.mercadolibre.com/billing/integration/periods/key/2023-10-01/summary/details
```

**Response:**

```javascript
{
    "user": {
        "nickname": "TEST"
    },
    "period": {
        "date_from": "2023-06-19",
        "date_to": "2023-07-18",
        "expiration_date": "2023-07-24",
        "key": "2023-07-01"
    },
    "bill_includes": {
        "total_amount": 171070532.64,
        "total_perceptions": 33077380.48,
        "bonuses": [
            {
                "label": "Mercado Envíos charge bonus",
                "amount": 385261.63,
                "type": "BXD",
                "groupId": 3
            },
            {
                "label": "Sale charge bonus",
                "amount": 6123337.46,
                "type": "BXD",
                "groupId": 4
            }
        ],
        "charges": [
            {
                "label": "Advertising campaigns - Product Ads",
                "amount": 48600,
                "type": "PADS",
                "groupId": 24
            },
            {
                "label": "Mercado Envíos charge",
                "amount": 11195255.36,
                "type": "CXD",
                "groupId": 24
            },
            {
                "label": "Sale charge",
                "amount": 131285530.48,
                "type": "CV",
                "groupId": 28
            }
        ]
    },
    "payment_collected": {
        "operation_discount": 136492738.16,
        "total_payment": 33353689.85,
        "total_credit_note": 1989281,
        "total_collected": 171070532.64,
        "total_debt": 0.00
    },
    "errors": []
}
```

### Response parameters

-   **user**:
    -   **nickname**: username.
-   **period**:
    -   **date\_from**: period start date.
    -   **date\_to**: period end date.
    -   **expiration\_date**: expiration date.
    -   **key**: first day of the month date.
-   **bill\_includes**:
    -   **total\_amount**: total value.
    -   **total\_perceptions**: total perceptions value.
    -   **bonuses**: list of bonuses.
        -   **label**: bonus description.
        -   **amount**: bonus value.
        -   **type**: bonus type.
        -   **groupId**: bonus group.
    -   **charges**: list of charges.
        -   **label**: charge description.
        -   **amount**: charge value.
        -   **type**: charge type.
        -   **groupId**: charge group.
-   **payment\_collected**:
    -   **operation\_discount**: operations discounted from sales.
    -   **total\_payment**: payments made.
    -   **total\_credit\_note**: total credit notes.
    -   **total\_collected**: total collected.
    -   **total\_debt**: total debt.

  

## Bonus Types

Bonuses can be for the following concepts:

-   **Sale and shipping charges**: if a sale is not completed due to a return or shipping issues (such as product loss or damage), we reimburse the sale commission and shipping cost.
-   **Advertising charges**: if you mistakenly contracted the service or there was a problem with the charge, we reimburse the difference.
-   **Tax Perception Bonuses**: when a sale charge is returned, the corresponding VAT tax perception refund is also included (whether for a new or used item) and Gross Income Taxes. The same applies if there are errors in applying a perception.
-   **charges**: different charges that the seller may have: sales commissions, publication costs, tax perceptions, service charges. For example: Mercado Envíos. If you contract advertising campaigns, they will also appear in charges.

  

## Errors

Code

Type

Message

Solution

206

Partial content

An error occurred while retrieving the information. Try again.

Occurs when some data is missing and the response is incomplete. Applies to all resources, except for legal document download and reconciliation report in XLSX and CSV format.

429

Too Many Requests

Preventive blocking due to limited number of requests per IP.

Avoid making repetitive calls that do not require the use of limit and offset for pagination.

  

Contents

-   [
    
    Billing Reports
    
    
    
    ](#)
-   [
    
    Get period
    
    
    
    ](#get-period)
-   [
    
    Get Documents for a Period
    
    
    
    ](#get-documents)
-   [
    
    Billing Summary
    
    
    
    ](#billing-summary)
-   [
    
    Bonus Types
    
    
    
    ](#bonus-types)
-   [
    
    Errors
    
    
    
    ](#errors)

[](#)