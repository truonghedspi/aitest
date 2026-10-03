---
name: api-input-validation
description: Soạn case kiểm tra ràng buộc đầu vào của API (trường bắt buộc, enum, định dạng, giá trị biên, bội số) từ schema OpenAPI. Dùng khi người dùng muốn kiểm tra API từ chối dữ liệu sai hoặc kiểm tra giá trị biên.
metadata:
  systems: order-service
---

# Kiểm tra ràng buộc đầu vào của API

1. Gọi `get_system_context` và đọc dòng `body:` của operation: mỗi ràng buộc là một nguồn case.
   `*` là bắt buộc; `A|B` là enum; `/…/` là định dạng; `≥`, `≤` là biên; `×` là bội số.
2. Với mỗi ràng buộc, lập bảng: giá trị hợp lệ sát biên, giá trị vi phạm sát biên, kết quả mong đợi theo đặc tả.
   Ví dụ `qty: integer ≥100 ×100` → 100 (201), 0 (400), 150 (400), 200 (201).
   Đưa bảng này cho người dùng xác nhận trước khi viết plan.
3. Mỗi dòng vi phạm là một case riêng: một bước `call:` với body chỉ sai đúng một trường, các trường khác hợp lệ.
4. Expectation của case vi phạm: mã lỗi (thường 400) **và** dữ liệu không được lưu (đếm bản ghi trong DB bằng 0).
   Mã HTTP khai báo `from: { step: 1, path: $.status }` để nền tảng tự đối chiếu; phần đếm DB để agent assert.
   Lọc bản ghi theo giá trị riêng của case (ví dụ mã chứng khoán riêng) để không lẫn dữ liệu khác.
5. `validate_plan` cảnh báo giá trị sai schema trong case vi phạm; cảnh báo này là chủ đích, không cần sửa.

Plan mẫu: `examples/order-qty.plan.yaml` (đọc bằng `read_skill_file`).
