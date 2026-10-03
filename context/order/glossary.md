---
title: Thuật ngữ nghiệp vụ lệnh chứng khoán
description: Nghĩa của lô chẵn, lệnh lẻ, trạng thái lệnh, phí, vị thế; dùng khi soạn plan cho Order API.
systems: [order-service]
features: [order]
---

# Thuật ngữ nghiệp vụ lệnh

| Thuật ngữ | Nghĩa |
|---|---|
| Lô chẵn | Khối lượng là bội số của 100; lệnh lô lẻ bị từ chối |
| `NEW` | Lệnh vừa nhận, chưa khớp; chỉ trạng thái này được huỷ |
| `FILLED` | Lệnh đã khớp toàn bộ (lệnh có `callback_url` khớp sau khoảng 1,5 giây) |
| `CANCELLED` | Lệnh đã huỷ; không huỷ lại được (409) |
| Phí | 0,15% giá trị lệnh, tính bằng nghìn đồng, làm tròn nửa lên 2 chữ số |
| Vị thế | Tổng mua trừ tổng bán của một mã, bỏ lệnh đã huỷ |
