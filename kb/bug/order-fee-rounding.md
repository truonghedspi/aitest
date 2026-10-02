---
id: order-fee-rounding
type: bug
title: Phí giao dịch làm tròn sai ở giá trị biên
status: open
feature: order
cases:
  - TP-ORDER-FEE-001/FEE-02
source: run:2026-10-01T16-38-21-007Z-TP-ORDER-FEE-001
created: 2026-10-01
updated: 2026-10-01
---

Order API tính `fee` bằng số thực rồi `toFixed(2)`, nên giá trị biên làm tròn sai: qty 100, price 10.300 → phí đúng 1,545 → 1,55, API trả 1,54.

Bằng chứng: lượt chạy `2026-10-01T16-38-21-007Z-TP-ORDER-FEE-001`, expectation `fee-correct` mong đợi `1.55` (tính bằng công thức), thực tế `1.54`.
