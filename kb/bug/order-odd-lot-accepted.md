---
id: order-odd-lot-accepted
type: bug
title: Order API chấp nhận lệnh lẻ lô
status: open
feature: order
cases:
  - TP-ORDER-001/TC-03
  - TP-ORDER-PLACE-001/ORD-02
source: run:2026-10-01T05-40-15-012Z-TP-ORDER-001
created: 2026-10-01
updated: 2026-10-01
---

`POST /orders` với `qty = 150` trả HTTP 201 và lưu bản ghi, trái đặc tả mục 1: `qty` phải là bội số của 100.

Bằng chứng: lượt chạy `2026-10-01T05-40-15-012Z-TP-ORDER-001`, expectation `http-400` có giá trị thực tế 201, `db-none` có giá trị thực tế 1.
