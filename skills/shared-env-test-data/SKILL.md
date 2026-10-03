---
name: shared-env-test-data
description: Chuẩn bị dữ liệu cho plan chạy trên môi trường tích hợp dùng chung (dữ liệu thay đổi theo thời điểm, nhiều người cùng dùng) bằng inputs, fill, prepare và dọn dữ liệu. Dùng khi plan cần lệnh, tài khoản, bản ghi có sẵn hoặc chạy trên staging.
---

# Dữ liệu trên môi trường dùng chung

1. Không ghi cứng mã tài khoản, mã lệnh, ngày. Khai báo trong `inputs` và dùng `{{tên}}`.
2. Chọn nguồn giá trị theo thứ tự: người chạy điền → `fill` (bước xác định: API, INSERT, truy vấn) → `prepare`
   (mô tả bằng lời cho agent: "tìm…, không có thì tạo…") → `default`.
3. Dữ liệu tạo ra gắn `{{$run.short}}` vào trường cho phép (mã tham chiếu, ghi chú); `fill` tạo dữ liệu thì khai báo `cleanup`.
4. Điều kiện môi trường (phiên giao dịch mở, số dư đủ) khai báo bằng `require`; không thoả thì lượt chạy `blocked`, không `fail`.
5. Dọn theo mã vừa tạo, không xoá theo điều kiện rộng (`DELETE … WHERE symbol = …`).

Plan mẫu: `examples/plans/order-inputs.plan.yaml`.
